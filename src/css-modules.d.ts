/** CSS Modules type declaration: `import css from './x.module.css'` yields the hashed class map. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
