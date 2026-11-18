'use strict';

const ALLOWED_KEYS = [
  'url',
  'uri',
  'method',
  'headers',
  'body',
  'json',
  'qs',
  'timeout',
  'followRedirect'
];

class UnsupportedOption extends Error {
  constructor(key) {
    super('Unsupported option: ' + key);
    this.name = 'UnsupportedOption';
    this.key = key;
  }
}

function buildUrl(baseUrl, qs) {
  if (baseUrl === undefined || baseUrl === null) {
    return baseUrl;
  }
  if (!qs) {
    return baseUrl;
  }
  let queryString = '';
  if (typeof qs === 'string') {
    queryString = qs;
  } else if (typeof qs === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(qs)) {
      if (v !== undefined) {
        params.append(k, String(v));
      }
    }
    queryString = params.toString();
  }
  if (!queryString) {
    return baseUrl;
  }
  const str = String(baseUrl);
  if (str.endsWith('?') || str.endsWith('&')) {
    return str + queryString;
  }
  return str + (str.includes('?') ? '&' : '?') + queryString;
}

function toFetchInit(opts) {
  const init = {};

  if (opts.method) {
    init.method = opts.method;
  }

  const headers = opts.headers ? Object.assign({}, opts.headers) : {};

  let body = opts.body;
  if (body === undefined && typeof opts.json === 'object' && opts.json !== null) {
    body = JSON.stringify(opts.json);
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  } else if (body !== undefined) {
    if (opts.json === true || (typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array))) {
      if (typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        body = JSON.stringify(body);
      }
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  if (opts.json === true) {
    if (!headers['accept'] && !headers['Accept']) {
      headers['Accept'] = 'application/json';
    }
  }

  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }

  const method = (init.method || 'GET').toUpperCase();
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }

  if (typeof opts.timeout === 'number' && opts.timeout > 0) {
    init.signal = AbortSignal.timeout(opts.timeout);
  }

  if (opts.followRedirect === false) {
    init.redirect = 'manual';
  } else if (opts.followRedirect === true) {
    init.redirect = 'follow';
  }

  return init;
}

function requestCompat(options, callback) {
  const opts = options || {};
  for (const key of Object.keys(opts)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new UnsupportedOption(key);
    }
  }

  let called = false;
  const done = (err, response, body) => {
    if (called) return;
    called = true;
    callback(err, response, body);
  };

  (async () => {
    let raw;
    let text;
    try {
      const url = opts.url !== undefined ? opts.url : opts.uri;
      const finalUrl = buildUrl(url, opts.qs);
      const init = toFetchInit(opts);
      raw = await fetch(finalUrl, init);
      text = await raw.text();
    } catch (networkError) {
      done(networkError, null, null);
      return;
    }

    raw.statusCode = raw.status;

    let body = text;
    if (opts.json === true && text !== '') {
      try {
        body = JSON.parse(text);
      } catch (_parseErr) {
        // Invalid JSON behaviour is "unknown" in the spec: record it in a comment and pass the raw text.
        body = text;
      }
    }

    done(null, raw, body);
  })();
}

module.exports = requestCompat;
module.exports.requestCompat = requestCompat;
module.exports.default = requestCompat;
module.exports.ALLOWED_KEYS = ALLOWED_KEYS;
module.exports.UnsupportedOption = UnsupportedOption;
