'use strict';

const crypto = require('crypto');
const restify = require('restify');
const restifyErrors = require('restify-errors');
const storj = require('storj-lib');
const ReadableStream = require('readable-stream');
const inherits = require('util').inherits;
const Logger = require('kad-logger-json');
const StorageModels = require('storj-service-storage-models');
const points = StorageModels.constants.POINTS;
const merge = require('merge');
const assert = require('assert');
const LandlordConfig = require('./config').LandlordConfig;
const utils = require('./utils');

/**
 * Creates an RPC server for issuing work to a renter pool
 * @constructor
 * @param {Object} options
 * @param {Number} options.serverPort - The port to listen on
 * @param {Object} options.serverOpts - Options to pass wot Restify server
 * @param {String} options.amqpUrl - The RabbitMQ server URL
 * @param {Object} options.amqpOpts - Option to pass to RabbitMQ context
 * @param {Number} options.logLevel - The verbosity level for logging
 */
function Landlord(options) {
  if (!(this instanceof Landlord)) {
    return new Landlord(options);
  }

  this._opts = options instanceof LandlordConfig ?
               options.toObject() :
               options;

  this._logger = new Logger(this._opts.logLevel);

  this._pendingJobs = {};

  this.server = restify.createServer(merge({
    name: 'Storj Complex'
  }, this._opts.serverOpts));

  this._workerSockets = {};
  this._bindServerRoutes();
  ReadableStream.call(this);
  this._logger.on('data', this.push.bind(this));

  this._requestTimeout = this._opts.requestTimeout || Landlord.REQUEST_TIMEOUT;
}

inherits(Landlord, ReadableStream);

Landlord.REQUEST_TIMEOUT = 90000;

/**
 * Initializes storage instance
 * @private
 */
Landlord.prototype._initStorage = function() {
  this.storage = new StorageModels(
    this._opts.mongoUrl,
    this._opts.mongoOpts,
    {
      logger: this._logger
    }
  );
};

/**
 * @private
 */
Landlord.prototype._read = storj.utils.noop;

/**
 * Binds the server routes
 * @private
 */
Landlord.prototype._bindServerRoutes = function() {
  this._logger.info('binding rpc server routes');
  this.server.use(restify.plugins.authorizationParser());
  this.server.use(restify.plugins.bodyParser());
  this.server.post('/', this._handleJsonRpcRequest.bind(this));
};

/**
 * Starts the landlord service
 * @param {Landlord~startCallback}
 */
Landlord.prototype.start = function(callback) {
  var self = this;

  // Set up our database connection for shared contract storage
  this._initStorage();

  // Start our RPC server
  this._logger.info('starting rpc server on port %s', this._opts.serverPort);
  this.server.listen(this._opts.serverPort);

  this._setupRabbitmq = utils.setupRabbitmq.bind(this);
  this._setupRabbitmq();

  // When we are all connected, fire the callback
  this.once('ready', function() {
    self._logger.info('landlord is connected and listening');
    this.removeAllListeners('error');
    callback();
  });

  // Otherwise bubble any errors
  this.once('error', function(err) {
    this.removeAllListeners('ready');
    callback(err);
  });
};
/**
 * @callback Landlord~startCallback
 * @param {Error} [error]
 */

/**
 * Initialize the rabbitmq message bus
 * @private
 */
Landlord.prototype._initMessageBus = function() {
  this._logger.info('initializing message bus');

  // Setup our amqp sockets
  this.subscriber = this._amqpContext.socket('SUBSCRIBE');

  // Connect to our renter minion and listen for finished work
  this.subscriber.connect('work.close');
  this._establishWorkSockets();

  // Set up handlers for receiving work
  // Set up handlers for renter alerts
  this.subscriber.on('data', this._handleWorkResult.bind(this));
  this.emit('ready');
};

/**
 * Returns the worker socket for the given key
 * @param {String} key
 */
Landlord.prototype.getWorkerSocketForKey = function(key) {
  var byteValue = Buffer.from(key, 'hex')[0];
  var exchangeName = 'work-x-' + Buffer.from([byteValue]).toString('hex');
  return this._workerSockets[exchangeName];
};

/**
 * Establishes sockets for each possible first bit of renter node id
 * @private
 */
Landlord.prototype._establishWorkSockets = function() {
  for (let b = 0; b < 256; b++) {
    let name = 'work-x-' + Buffer.from([b]).toString('hex');
    let sock = this._workerSockets[name] = this._amqpContext.socket('PUSH');
    sock.connect(name);
  }

  return this._workerSockets;
};

/**
 * Will check that a JSON-RPC request is valid
 * @private
 * @param {Object} req
 * @returns {Error}
 */
Landlord.prototype._checkJsonRpcRequest = function(req) {

  var authRequest = req.authorization.basic;
  var authConfig = this._opts.serverOpts.authorization;

  // Make sure that the auth credentials match what's configured
  if (
    typeof authRequest === 'undefined' ||
    !(authRequest.username === authConfig.username &&
      authRequest.password === authConfig.password)
  ) {
    this._logger.warn('unauthorized rpc attempt');
    return new restifyErrors.UnauthorizedError('Not authorized');
  }

  // Make sure this is a valid JSON RPC request
  if (!this._isValidJsonRpcRequest(req.body)) {
    this._logger.warn('invalid rpc message received');
    return new restifyErrors.BadRequestError('Bad request');
  }
};

Landlord.prototype._logRequestTimeout = function(rpc) {
  let dataHash;
  let nodeID;

  switch (rpc.method) {
    case 'getConsignmentPointer':
    case 'getRetrievalPointer':
    case 'getStorageProof':
      nodeID = rpc.params[0].nodeID;
      dataHash = rpc.params[1].data_hash;
      break;
    case 'getStorageOffer':
      dataHash = rpc.params[0].data_hash;
      break;
  }

  this._logger.warn('job timed out, method: %s, id: %s, ' +
                    'data_hash: %s, node_id: %s',
                    rpc.method, rpc.id, dataHash, nodeID);

  if (nodeID) {
    this._recordRequestTimeout(nodeID);
  }

};

Landlord.prototype._recordRequestTimeout = function(nodeID) {
  this.storage.models.Contact.findOne({_id: nodeID}, (err, contact) => {
    if (err) {
      this._logger.warn('recordRequestTimeout: Error trying to find contact ' +
                        ' %s, reason: %s', nodeID, err.message);
      return;
    }

    if (!contact) {
      this._logger.warn('recordRequestTimeout: Unable to find contact %s',
                        nodeID);
      return;
    }

    contact.recordTimeoutFailure();
    contact.recordPoints(points.REQUEST_TIMEOUT);

    assert(this._opts.timeoutRateThreshold, 'timeoutRateThreshold is expected');

    if (contact.timeoutRate >= this._opts.timeoutRateThreshold) {
      this._logger.warn('Shards need replication, farmer: %s, timeoutRate: %s',
                        contact.nodeID, contact.timeoutRate);
    }

    contact.recordResponseTime(this._requestTimeout);

    contact.save((err) => {
      if (err) {
        this._logger.warn('recordRequestTimeout: Unable to save contact %s ' +
                          'to update lastTimeout.', nodeID);
      }
    });
  });
};

/**
 * Will set a timeout for JSON-RPC requests
 * @param {Object} req
 * @private
 */
Landlord.prototype._setJsonRpcRequestTimeout = function(req) {
  var self = this;

  // If work isn't completed in time, respond with an error
  setTimeout(function() {
    if (!self._pendingJobs[req.body.id]) {
      return;
    }

    self._logRequestTimeout(req.body);

    self._pendingJobs[req.body.id].res.send(
      new restifyErrors.RequestTimeoutError()
    );

    delete self._pendingJobs[req.body.id];

  }, self._requestTimeout);
};

/**
 * Handles an incoming JSON-RPC request
 * @private
 */
Landlord.prototype._handleJsonRpcRequest = function(req, res) {
  var error = this._checkJsonRpcRequest(req);

  if (error) {
    return res.send(error);
  }

  // Determine which exchange to publish work to
  var key = this._getKeyFromRpcMessage(req.body);
  var exchange = this.getWorkerSocketForKey(key);

  // Keep track of the request/response object for later
  this._pendingJobs[req.body.id] = {
    req: req,
    res: res,
    start: Date.now()
  };

  // Add work to the renter pool
  const rpc = req.body;
  this._logger.debug('rpc: %j', rpc);

  let dataHash;
  let nodeID;
  switch (rpc.method) {
    case 'getConsignmentPointer':
    case 'getRetrievalPointer':
    case 'getStorageProof':
      nodeID = rpc.params[0].nodeID;
      dataHash = rpc.params[1].data_hash;
      break;
    case 'getStorageOffer':
      dataHash = rpc.params[0].data_hash;
      break;
  }

  this._logger.info('queueing job, method: %s, id: %s, ' +
                   'data_hash: %s, node_id: %s',
                   rpc.method, rpc.id, dataHash, nodeID);

  this._setJsonRpcRequestTimeout(req);

  exchange.write(Buffer.from(JSON.stringify(req.body)));
};

/**
 * Extracts the key from the RPC request payload
 * @private
 */
Landlord.prototype._getKeyFromRpcMessage = function(rpc) {
  /* jshint maxcomplexity:false */
  switch (rpc.method) {
    case 'getConsignmentPointer':
    case 'getRetrievalPointer':
    case 'renewContract':
    case 'ping':
    case 'getStorageProof':
      return rpc.params[0].nodeID; // Key based on the target farmer
    case 'getStorageOffer':
      return rpc.params[0].data_hash; // Key based on the data hash
    case 'getMirrorNodes':
      return rpc.params[1][0].nodeID; // Key based on the destination pointer
    case 'publishContract':
      return rpc.params[0][0]._id; // Key based on the first farmer
    default:
      return crypto.randomBytes(1).toString('hex'); // Select a random exchange
  }
};

/**
 * Validates a JSON-RPC request
 * @private
 */
Landlord.prototype._isValidJsonRpcRequest = function(body) {
  try {
    assert(typeof body.id === 'string');
    assert(Array.isArray(body.params));
    assert(typeof body.method === 'string');
  } catch (err) {
    return false;
  }

  return true;
};

/**
 * Updates the exponential moving average response time
 * for the farmer.
 * @private
 */
Landlord.prototype._recordSuccessTime = function(job) {
  const rpc = job.req.body;
  const responseTime = Date.now() - job.start;

  if (!Number.isFinite(responseTime)) {
    this._logger.warn('recordSuccesstime: responseTime is not finite %s',
                      responseTime);
    return;
  }

  let nodeID;

  switch (rpc.method) {
    case 'getConsignmentPointer':
    case 'getRetrievalPointer':
    case 'getStorageProof':
      nodeID = rpc.params[0].nodeID;
      break;
  }

  if (!nodeID) {
    // No need to record time
    return;
  }

  this.storage.models.Contact.findOne({_id: nodeID}, (err, contact) => {
    if (err) {
      this._logger.warn('recordSuccesstime: Error trying to find contact ' +
                        ' %s, reason: %s', nodeID, err.message);
      return;
    }

    if (!contact) {
      this._logger.warn('recordSuccesstime: Unable to find contact %s',
                        nodeID);
      return;
    }

    contact.recordPoints(points.REQUEST_SUCCESS);
    contact.recordResponseTime(responseTime).save((err) => {
      if (err) {
        this._logger.warn('recordSuccessTime: Unable to save contact %s ' +
                          'to update responseTime.', nodeID);
      }
    });

  });
};

/**
 * Handle the result of some work completed
 * @private
 */
Landlord.prototype._handleWorkResult = function(buffer) {
  var self = this;
  var data = JSON.parse(buffer.toString());

  //jshint noempty: false
  if (!self._pendingJobs[data.id]) {
    //When there are multiple landlords running, this log will falsely
    //report that there is work completed late when it wasn't.
    //this._logger.warn('job %s completed late after it timed out',
    //                  data.id);
  } else if (data.error) {
    self._logger.warn('error returned from work result on job %s, reason: %j',
                      data.id, data);
    self._pendingJobs[data.id].res.send(
      new restifyErrors.InternalServerError(data.error.message)
    );
  } else {
    self._logger.debug('job %s completed successfully, result: %j',
                       data.id, data);
    self._pendingJobs[data.id].res.send(data);

    self._recordSuccessTime(self._pendingJobs[data.id]);
  }

  delete self._pendingJobs[data.id];
};

module.exports = Landlord;
