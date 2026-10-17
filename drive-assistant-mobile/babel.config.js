module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    require.resolve('@babel/plugin-transform-export-namespace-from'),
    [
      require.resolve('babel-plugin-module-resolver'),
      {
        root: ['./src'],
        alias: {
          '@app': './src/app',
          '@features': './src/features',
          '@shared': './src/shared',
        },
      },
    ],
  ],
};
