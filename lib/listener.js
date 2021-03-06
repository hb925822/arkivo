'use strict';

// --- Module Dependencies ---
var assert = require('assert');
var debug  = require('debug')('arkivo:listener');
var B = require('bluebird');
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;

var config = require('./config').listener;
var zotero = require('./zotero');
var common = require('./common');

var extend = common.extend;
var index = common.findIndex;
var pick  = common.pick;
var pluck = common.pluck;

/** @module arkivo */

/**
 * Connects to the Zotero Stream API and listens
 * for notifications.
 *
 * @class Listener
 * @constructor
 * @extends EventEmitter
 */
function Listener(options) {
  EventEmitter.call(this);

  this.options = extend({}, config, options);

  this.current = [];
  this.pending = [];
}

inherits(Listener, EventEmitter);

Listener.prototype.subscribed = function (subscriptions, errors) {
  var i, ii, j, jj, key, subscription;

  if (subscriptions) {

    for (i = 0, ii = subscriptions.length; i < ii; ++i) {
      subscription = subscriptions[i];
      key = subscription.apiKey;

      for (j = 0, jj = subscription.topics.length; j < jj; ++j)
        this.resolve(key, subscription.topics[j]);
    }

  }

  if (errors) {

    for (i = 0, ii = errors.length; i < ii; ++i)
      this.reject.apply(this, pluck(errors[i], 'apiKey', 'topic', 'error'));

  }
};

Listener.prototype.updated = function (data) {
  var i, ii, s;
  var predicate = by(pick(data, 'apiKey', 'topic'));

  debug('topic %s updated...', data.topic);

  for (i = 0, ii = this.current.length; i < ii; ++i) {
    s = this.current[i];

    if (predicate(s))
      this.emit('updated', s);
  }

  return this;
};

Listener.prototype.resolve = function (key, topic) {
  var s;
  var data;

  while ((s = remove(this.pending, { key: key, topic: topic }))) {
    debug('[%s] listening for updates of %s...', s.id, topic);

    data = pick(s, 'id', 'key', 'topic');

    s.resolve(data);

    this.current.push(data);
    this.emit('added', data);
  }

  return this;
};

Listener.prototype.reject = function (key, topic, reason) {
  var s, error;

  while ((s = remove(this.pending, { key: key, topic: topic }))) {
    debug('[%s] failed to subscribe %s: %s', s.id, topic, reason);

    error = new Error(reason);
    error.data = pick(s, 'id', 'key', 'topic');

    s.reject(error);
  }

  return this;
};

Listener.prototype.register = function (subscription) {
  var data = pick(subscription, 'id', 'key', 'topic');

  var promise = new B(function (resolve, reject) {
    data.resolve = resolve;
    data.reject  = reject;
  });

  this.pending.push(data);

  return promise;
};

Listener.prototype.add = function (subscriptions) {
  var self = this;
  var register = this.register.bind(this);

  assert(subscriptions);

  return new B(function (resolve, reject) {
    assert(self.stream);

    if (!Array.isArray(subscriptions))
      subscriptions = [subscriptions];

    assert(subscriptions.length);
    debug('adding %d subscription(s)...', subscriptions.length);

    var data = subscriptions.map(toData);

    self.stream.subscribe(data, function (error) {
      if (error) return reject(error);

      B.all(subscriptions.map(register)).then(resolve, reject);
    });
  });
};


Listener.prototype.remove = function (subscription) {
  var self = this;

  return new B(function (resolve, reject) {
    assert(self.stream);

    var data = remove(self.current, { id: subscription.id });

    if (!data) {
      debug('failed to remove %s: not registered', subscription.id);
      return reject(new Error('not registered'));
    }

    self.stream.unsubscribe({
      apiKey: data.key, topic: data.topic

    }, function (error) {
      if (error) {
        debug('failed to remove %s: %s', subscription.id, error);
        return reject(error);
      }

      debug('successfully removed %s from stream', subscription.id);
      resolve(data);
    });
  });
};


Listener.prototype.start = function () {
  assert(!this.stream);

  debug('starting...');

  this.stream = zotero
    .stream(this.options)
    .on('topicUpdated', this.updated.bind(this))
    .on('subscriptionsCreated', this.subscribed.bind(this))
    .on('connected', this.emit.bind(this, 'connected'))
    .on('error', this.emit.bind(this, 'error'));

  return this;
};


/**
 * @method stop
 * @param {Number} [timeout]
 * @return {Promise<this>}
 */
Listener.prototype.stop = function (timeout) {
  var self = this;
  timeout = timeout || 0;

  debug('shutting down (with %dms grace period)...', timeout);

  return new B(function (done) {
    if (self.stream)
      self.stream.on('close', done).close();
    else
      done();

  }).timeout(timeout, 'shutdown timed out')
    .return(self)

    .finally(function () {
      debug('shut down complete');

      if (self.stream) self.stream.removeAllListeners();
      delete self.stream;
    });
};


// --- Private Helpers ---

function remove(list, properties) {
  var idx = index(list, by(properties));

  return (idx !== -1) ? list.splice(idx, 1)[0] : null;
}

function by(properties) {
  properties.key = properties.apiKey;
  delete properties.apiKey;

  return function match(s) {

    for (var key in properties)
      if (properties[key] != null && properties[key] !== s[key])
        return false;

    return true;
  };
}

function toData(subscription) {
  var data = { topics: [subscription.topic] };

  if (subscription.key)
    data.apiKey = subscription.key;

  return data;
}

// --- Exports ---
module.exports = Listener;
