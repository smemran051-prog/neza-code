module.exports = {
  testMatch: ['**/tests/**/*.test.js'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron.js'
  },
  // 00_ENGINE ফোল্ডারের package.json ইগনোর করার জন্য
  modulePathIgnorePatterns: ['<rootDir>/00_ENGINE/'],
  silent: false,
  verbose: true
};