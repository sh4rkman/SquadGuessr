import Dotenv from 'dotenv-webpack';
import path from 'path';
import webpack from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import CssMinimizerPlugin from 'css-minimizer-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import WebpackPwaManifest from 'webpack-pwa-manifest';
import RobotstxtPlugin from 'robotstxt-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import workbox from 'workbox-webpack-plugin';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// For __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


export default async (env) => {

  // Dynamically import dotenv and await it since it's a Promise
  const { config } = await import('dotenv');
  config();

  // If you want webpack to add a robot.txt indexing, create a .env file with INDEX=TRUE
  const isIndexed = process.env.INDEX && process.env.INDEX.toLowerCase() === 'true';
  const robotstxtPolicy = isIndexed 
    ? [{ userAgent: "*", allow: "/" }] 
    : [{ userAgent: "*", disallow: "/" }];

  return {

    entry: {
      main: './src/app.js',
    },
    stats: { warnings: false},
    mode: env.WEBPACK_BUILD ? 'production' : 'development',
    devtool: env.WEBPACK_BUILD ? false : 'inline-source-map',
    output: {
        filename: './src/js/[name].[contenthash].min.js',
        path: path.resolve(__dirname, '../dist'),
        publicPath: '/',
        clean: true,
        assetModuleFilename: '[path][name].[contenthash][ext]'
    },
    module: {
        rules: [
          {
            test: /\.(sc|sa|c)ss$/i,
            use: [
              'style-loader', { loader: 'css-loader', options: { url: false } }, 'sass-loader',
            ],
          },
          { 
            test: /\.(html)$/,
            include: path.join(__dirname, ''),
            use: { loader: 'html-loader', options: { interpolate: true } }
          },
          { test: /\.(png|svg|jpg|jpeg|gif|webp)$/i, type: 'asset/resource', },
        ],
    },
    devServer: {
      port: process.env.DEV_PORT || 3000,
      open: true,
      historyApiFallback: {
        disableDotRule: true,
      },
      static: {
        directory: path.join(__dirname, '../public'),
        publicPath: '/',
      },
      proxy: [
        {
            context: ['/api/'],
            target: process.env.DEV_API_URL || 'https://beta.squadcalc.app',
            changeOrigin: true,
            ws: true,
            onProxyReq: (proxyReq) => {
                if (process.env.API_KEY) proxyReq.setHeader('X-API-Key', process.env.API_KEY);
            }
        }
      ]
    },
    plugins: [
        new Dotenv(),
        new HtmlWebpackPlugin({
          template: './src/components/index.html',
          minify: env.WEBPACK_BUILD ? {
              collapseWhitespace: true,
              removeComments: true,
              removeAttributeQuotes: true,
          } : false
        }),
        new CopyWebpackPlugin({
          patterns: [
            {
              // Public Assets
              from: path.resolve(__dirname, '../public'),
              to: path.resolve(__dirname, '../dist'),
            }
          ],
        }),
        new webpack.ProvidePlugin({
            $: "jquery", jQuery: "jquery", "window.jQuery": "jquery'", "window.$": "jquery"
        }),
        new RobotstxtPlugin({
          policy: robotstxtPolicy,
        }),
    ],
    performance: {
        hints: false,
        maxEntrypointSize: env.WEBPACK_BUILD ? 512000 : Infinity,
        maxAssetSize: env.WEBPACK_BUILD ? 512000 : Infinity,
    },
    optimization: {
      moduleIds: 'deterministic',
      runtimeChunk: 'single',
      splitChunks: {
          cacheGroups: {
              vendor: {
                  test: /[\\/]node_modules[\\/]/,
                  name: 'vendors',
                  chunks: 'all',
                  maxSize: env.WEBPACK_BUILD ? 50000 : Infinity,
              },
          },
      },
      minimizer: env.WEBPACK_BUILD ? [
          new CssMinimizerPlugin(), //CSS
          new TerserPlugin({
              extractComments: false,
              terserOptions: {
                  format: {
                      comments: false,
                  },
                  compress: {
                    pure_funcs: ['console.debug'], // Removes console.debug
                  },
              },
          }),
      ] : [],
    },
  }
};