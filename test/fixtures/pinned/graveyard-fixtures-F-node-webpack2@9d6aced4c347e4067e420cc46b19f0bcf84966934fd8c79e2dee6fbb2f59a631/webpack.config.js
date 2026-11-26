const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: {
    app: './index.js',
    vendor: ['lodash']
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  plugins: [
    new webpack.optimize.CommonsChunkPlugin({
      name: 'vendor'
    })
  ]
};
