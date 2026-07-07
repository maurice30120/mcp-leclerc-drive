const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration du Drive Assistant Mobile.
 *
 * Configuration native standard React Native CLI pour iOS/Android.
 */

const config = {
  resolver: {
    resolveRequest(context, moduleName, platform) {
      if (moduleName.endsWith('/extra/observability/telemetry.js')) {
        return {
          type: 'sourceFile',
          filePath: path.resolve(__dirname, 'src/shims/mistral-telemetry.js'),
        };
      }
      if (moduleName.endsWith('/extra/observability/otel.js')) {
        return {
          type: 'sourceFile',
          filePath: path.resolve(__dirname, 'src/shims/mistral-otel.js'),
        };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
