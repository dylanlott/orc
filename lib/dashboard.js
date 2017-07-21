'use strict';

const path = require('path');
const http = require('http');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');


/**
 * Creates and serves a web application frontend for managing an ORC node
 */
class Dashboard {

  /**
   * @constructor
   * @param {object} options
   * @param {object} options.logger
   */
  constructor(options) {
    this.logger = options.logger;
    this.server = this._createServer();
  }

  /**
   * @private
   */
  _createServer() {
    const handler = serveStatic(path.join(__dirname, '../gui'));
    const server = http.createServer((req, res) => {
      handler(req, res, finalhandler(req, res));
    });

    return server;
  }

  /**
   * Start the server on the supplied port
   * @param {number} port
   * @param {string} hostname
   * @param {function} callback
   */
  listen() {
    this.server.listen(...arguments);
  }

}


module.exports = Dashboard;
