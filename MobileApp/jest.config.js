module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: [],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|centrifuge))',
  ],
};
