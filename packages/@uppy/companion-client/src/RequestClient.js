'use strict'

const AuthError = require('./AuthError')

// Remove the trailing slash so we can always safely append /xyz.
function stripSlash (url) {
  return url.replace(/\/$/, '')
}

module.exports = class RequestClient {
  static VERSION = require('../package.json').version

  constructor (uppy, opts) {
    this.uppy = uppy
    this.opts = opts
    this.onReceiveResponse = this.onReceiveResponse.bind(this)
    this.allowedHeaders = ['accept', 'content-type', 'uppy-auth-token']
    this.preflightDone = false
  }

  get hostname () {
    const { companion } = this.uppy.getState()
    const host = this.opts.companionUrl
    return stripSlash(companion && companion[host] ? companion[host] : host)
  }

  get defaultHeaders () {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Uppy-Versions': '@uppy/companion-client=1.0.3'
    }
  }

  headers () {
    return Promise.resolve(
      Object.assign({}, this.defaultHeaders, this.opts.serverHeaders || {})
    )
  }

  _getPostResponseFunc (opts) {
    return (response) => {
      if (!opts.skipPostResponse) {
        return this.onReceiveResponse(response)
      }

      return response
    }
  }

  onReceiveResponse (response) {
    const state = this.uppy.getState()
    const companion = state.companion || {}
    const host = this.opts.companionUrl
    const headers = response.headers
    // Store the self-identified domain name for the Companion instance we just hit.
    if (headers.has('i-am') && headers.get('i-am') !== companion[host]) {
      this.uppy.setState({
        companion: Object.assign({}, companion, {
          [host]: headers.get('i-am')
        })
      })
    }
    return response
  }

  // Handle old request options style
  _getOptions (opts) {
    if (typeof opts === 'boolean') {
      return { skipPostResponse: opts }
    }
    return opts
  }

  _getUrl (url) {
    if (/^(https?:|)\/\//.test(url)) {
      return url
    }
    return `${this.hostname}/${url}`
  }

  _json (res) {
    if (res.status === 401) {
      throw new AuthError()
    }

    if (res.status < 200 || res.status > 300) {
      throw new Error(`Failed request to ${res.url}. ${res.statusText}`)
    }
    return res.json()
  }

  preflight (path, { signal }) {
    return new Promise((resolve, reject) => {
      if (this.preflightDone) {
        return resolve(this.allowedHeaders.slice())
      }

      fetch(this._getUrl(path), {
        method: 'OPTIONS',
        signal
      })
        .then((response) => {
          if (response.headers.has('access-control-allow-headers')) {
            this.allowedHeaders = response.headers.get('access-control-allow-headers')
              .split(',').map((headerName) => headerName.trim().toLowerCase())
          }
          this.preflightDone = true
          resolve(this.allowedHeaders.slice())
        })
        .catch((err) => {
          this.uppy.log(`[CompanionClient] unable to make preflight request ${err}`, 'warning')
          this.preflightDone = true
          resolve(this.allowedHeaders.slice())
        })
    })
  }

  preflightAndHeaders (path, opts) {
    return Promise.all([this.preflight(path, opts), this.headers()])
      .then(([allowedHeaders, headers]) => {
        // filter to keep only allowed Headers
        Object.keys(headers).forEach((header) => {
          if (allowedHeaders.indexOf(header.toLowerCase()) === -1) {
            this.uppy.log(`[CompanionClient] excluding unallowed header ${header}`)
            delete headers[header]
          }
        })

        return headers
      })
  }

  get (path, opts = {}) {
    opts = this._getOptions(opts)
    return new Promise((resolve, reject) => {
      this.preflightAndHeaders(path, opts).then((headers) => {
        fetch(this._getUrl(path), {
          method: 'get',
          headers: headers,
          credentials: 'same-origin',
          signal: opts.signal
        })
          .then(this._getPostResponseFunc(opts))
          .then((res) => this._json(res).then(resolve))
          .catch((err) => {
            err = err.isAuthError ? err : new Error(`Could not get ${this._getUrl(path)}. ${err}`)
            reject(err)
          })
      }).catch(reject)
    })
  }

  post (path, data, opts = {}) {
    opts = this._getOptions(opts)
    return new Promise((resolve, reject) => {
      this.preflightAndHeaders(path, opts).then((headers) => {
        fetch(this._getUrl(path), {
          method: 'post',
          headers: headers,
          credentials: 'same-origin',
          signal: opts.signal,
          body: JSON.stringify(data)
        })
          .then(this._getPostResponseFunc(opts))
          .then((res) => this._json(res).then(resolve))
          .catch((err) => {
            err = err.isAuthError ? err : new Error(`Could not post ${this._getUrl(path)}. ${err}`)
            reject(err)
          })
      }).catch(reject)
    })
  }

  delete (path, data, opts = {}) {
    opts = this._getOptions(opts)
    return new Promise((resolve, reject) => {
      this.preflightAndHeaders(path, opts).then((headers) => {
        fetch(`${this.hostname}/${path}`, {
          method: 'delete',
          headers: headers,
          credentials: 'same-origin',
          signal: opts.signal,
          body: data ? JSON.stringify(data) : null
        })
          .then(this._getPostResponseFunc(opts))
          .then((res) => this._json(res).then(resolve))
          .catch((err) => {
            err = err.isAuthError ? err : new Error(`Could not delete ${this._getUrl(path)}. ${err}`)
            reject(err)
          })
      }).catch(reject)
    })
  }
}
