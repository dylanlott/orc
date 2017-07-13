'use strict';

const sinon = require('sinon');
const expect = require('chai').expect;
const Bridge = require('../lib/bridge');

describe('@class Bridge', function() {
  const sandbox = sinon.sandbox.create();

  afterEach(() => sandbox.restore());

  describe('@constructor', function() {
    var bridge = new Bridge();
    expect(bridge).to.be.ok;
    expect(bridge.options).to.be.an('object');
  });
  
});
