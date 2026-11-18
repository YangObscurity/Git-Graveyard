const request = require('request');

request.get({ url: '/api/v1/health' }, function (err, res, body) {
  if (err) {
    return;
  }
});

request({ url: '/api/v1/items', method: 'POST', json: true }, function (err, res, body) {
  if (err) {
    return;
  }
});
