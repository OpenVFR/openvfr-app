module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          root: ['./src'],
          alias: {
            '@': './src',
            // sp-react-native-in-app-updates (force-update gate) pulls in
            // react-native-device-info, which isn't compatible with Expo's
            // managed/prebuild native module resolution -- redirect it to
            // the expo-constants-backed shim instead. See that file's header.
            'react-native-device-info': './react-native-device-info.js',
          },
          extensions: ['.ts', '.tsx', '.js', '.jsx'],
        },
      ],
    ],
  }
}
