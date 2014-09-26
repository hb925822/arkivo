//var sinon = require('sinon');
var chai   = require('chai');
var sinon  = require('sinon');
var expect = chai.expect;

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

var B = require('bluebird');

var plugins = require('../lib/plugins');

var Subscription = require('../lib/subscription');
var Synchronizer = require('../lib/sync');

var Session = Synchronizer.Session;
var sync = Synchronizer.singleton;

function delayed() { return B.delay(0); }

describe('Synchronizer', function () {
  it('is a constructor', function () {
    expect(Synchronizer).to.be.an('function');
  });

  it('has a singleton instance', function () {
    expect(sync).to.be.instanceof(Synchronizer);
  });

  describe('#synchronize', function () {
    var sub, version;

    beforeEach(function () {
      version = 1;
      sub = new Subscription({ url: '/users/42/items', version: version });

      sinon.stub(sub, 'save', delayed);
      sinon.spy(sub, 'touch');
      sinon.stub(sub, 'update');

      sinon.stub(Session.prototype, 'execute', function () {
        this.version = version;
        return delayed();
      });

      sinon.stub(sync, 'dispatch', delayed);
    });

    afterEach(function () {
      Session.prototype.execute.restore();
      sync.dispatch.restore();
    });

    it('returns a promise for Session instance', function () {
      return expect(sync.synchronize(sub))
        .to.eventually.be.instanceof(Session);
    });

    it('touches and saves the subscription', function () {
      expect(sub.touch).to.not.have.been.called;
      expect(sub.save).to.not.have.been.called;
      expect(sub.update).to.not.have.been.called;

      return sync.synchronize(sub)
        .then(function () {
          expect(sub.touch).to.have.been.called;
          expect(sub.save).to.have.been.called;
          expect(sub.update).to.not.have.been.called;
        });
    });

    it('passes the skip option on to the synchronization', function () {
      expect(Session.prototype.execute).to.not.have.been.called;

      return B.all([
          sync.synchronize(sub),
          sync.synchronize(sub, true),
        ])
        .then(function () {
          var execute = Session.prototype.execute;

          expect(execute).to.have.been.calledTwice;

          expect(!!execute.args[0][0]).to.be.false;
          expect(execute.args[1][0]).to.be.true;
        });
    });

    describe('when there are modifications', function () {
      beforeEach(function () {
        version = 42;
        //Session.prototype.version = 42;
      });
      afterEach(function () {
        //delete Session.prototype.version;
      });

      it('updates the subscription', function () {
        return sync.synchronize(sub)
          .then(function (s) {
            expect(sub.update).to.have.been.called;
            expect(sub.update.args[0][0]).to.have.property('version', 42);
          });
      });

      it('dispatches modified data to plugins', function () {
        return sync.synchronize(sub)
          .then(function () {
            expect(sync.dispatch).to.have.been.called;
          });
      });

      it('skips plugins if skip argument is true', function () {
        return sync.synchronize(sub, true)
          .then(function () {
            expect(sync.dispatch).to.not.have.been.called;
          });
      });
    });

    it('skips plugins if not modified', function () {
      return sync.synchronize(sub)
        .then(function () {
          expect(sync.dispatch).to.not.have.been.called;
        });
    });
  });

  describe('#update', function () {
    beforeEach(function () {
      sinon.stub(sync, 'synchronize', delayed);
    });

    afterEach(function () {
      sync.synchronize.restore();
    });

    it('delegates to .synchronize with skip set to true', function () {
      var sub = {};

      return sync.update(sub).then(function () {
        expect(sync.synchronize).to.have.been.called;

        expect(sync.synchronize.args[0][0]).to.equal(sub);
        expect(sync.synchronize.args[0][1]).to.be.true;
      });
    });
  });

  describe('#dispatch', function () {
    var data;

    beforeEach(function () {
      data = new Session(new Subscription());
      data.version = 1;
    });

    it('works when there are no plugins', function () {
      return expect(sync.dispatch(data)).to.be.fulfilled;
    });

    describe('when there are plugins', function () {
      var one, two;

      beforeEach(function () {
        one = sinon.stub().yields();
        two = sinon.stub();

        plugins.add({ name: 'one', process: one });
        plugins.add({ name: 'two', process: two });

        data.subscription.plugins.push({ name: 'one' });
      });

      afterEach(function () {
        plugins.reset();
      });

      it('dispatches the sync data to all plugins', function () {
        return sync.dispatch(data)
          .then(function () {
            expect(one).to.have.been.called;
            expect(one.args[0][0]).to.equal(data);

            expect(two).to.not.have.been.called;
          });
      });

      describe('but not all are available', function () {
        beforeEach(function () { plugins.reset(); });

        it('does not fail', function () {
          return expect(sync.dispatch(data)).to.be.fulfilled;
        });
      });

      describe('that return a promise', function () {
        var three;

        beforeEach(function () {
          three = sinon.stub().returns(B.delay(0));

          plugins.add({ name: 'three',  process: three });
          data.subscription.plugins.push({ name: 'three' });
        });

        it('works', function () {
          return sync.dispatch(data)
            .then(function () {
              expect(three).to.have.been.called;
            });
          });
      });
    });
  });

});

describe('Session', function () {
  it('is a constructor', function () {
    expect(Session).to.be.an('function');
  });

  describe('#get', function () {
    var s;

    beforeEach(function () {
      sinon.stub(sync.zotero, 'get');
      s = new Session(new Subscription());
    });

    afterEach(function () {
      sync.zotero.get.restore();
    });

    it('delegates to synchronizer\'s zotero client', function () {
      expect(sync.zotero.get).to.not.have.been.called;
      s.get('foo');
      expect(sync.zotero.get).to.have.been.called;
    });
  });

  describe('#diff', function () {
    var s;

    beforeEach(function () {
      s = new Session();
    });

    it('detects created items', function () {
      s.diff({ a: 1, b: 2, c: 4 }, { a: 1, b: 2 });
      expect(s.created).to.eql(['c']);
    });

    it('detects updated items', function () {
      s.diff({ a: 1, b: 3, c: 4 }, { a: 1, b: 2 });
      expect(s.updated).to.eql(['b']);
    });

    it('detects deleted items', function () {
      s.diff({ a: 1, c: 4 }, { a: 1, b: 2 });
      expect(s.deleted).to.eql(['b']);
    });

    it('returns empty CRUD lists when items stay the same', function () {
      s.diff({ a: 1, b: 2 }, { a: 1, b: 2 });

      expect(s.created).to.empty;
      expect(s.updated).to.empty;
      expect(s.deleted).to.empty;
    });
  });
});
