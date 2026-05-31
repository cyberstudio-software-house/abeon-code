// Use the web (jsdom) Expo preset, not the default native preset. The native
// preset loads Expo SDK 56's "winter" runtime, whose lazy global getters fire a
// require() that trips jest 30's between-tests guard. The web preset avoids it and
// runs both pure-logic and (react-native-web) component tests.
module.exports = {
  preset: 'jest-expo/web',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|centrifuge))',
  ],
};
