const _ = require('lodash');

function greet(name) {
  return _.capitalize(name);
}

module.exports = {
  greet: greet
};
