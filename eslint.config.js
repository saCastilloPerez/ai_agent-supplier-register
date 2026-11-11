import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'fixtures/**', 'web/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.js'], languageOptions: { globals: { process: 'readonly' } } }
)
