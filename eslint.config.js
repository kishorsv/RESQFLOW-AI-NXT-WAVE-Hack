import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'src/**/*', 'server/**/*', 'server.ts', '*.ts', '*.js', '.gmp_cache/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
