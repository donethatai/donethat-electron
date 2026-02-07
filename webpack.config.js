import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  // Set the mode to development or production
  mode: 'production',
  
  // Entry point of your application
  entry: './src/index.js',
  
  // Output configuration
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'build'),
  },
  
  // Enable source maps for debugging
  devtool: 'source-map',
  
  // Configure module resolution
  resolve: {
    // Add aliases to use browser versions of Firebase modules
    alias: {
      '@firebase/auth': path.resolve(__dirname, 'node_modules/@firebase/auth/dist/esm', 'index.js'),
      '@firebase/app': path.resolve(__dirname, 'node_modules/@firebase/app/dist/esm', 'index.esm.js'),
    },
    // Add file extensions to resolve
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.cjs']
  },
  
  // Configure module loaders
  module: {
    rules: [
      {
        // Process JavaScript files with Babel
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  
  // Configure target environment
  // Use a browser-style target so the bundled code does not rely on Node.js
  // globals like `require` in the sandboxed renderer.
  target: 'web'
};
