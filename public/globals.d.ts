// Vite-supplied ambients. The bundler resolves these; tsc needs them declared to check the rest of the
// file. __APP_VERSION__ is substituted as a string literal by the define block in vite.config.js.
declare const __APP_VERSION__: string;

declare module '*.css';

declare module '*?raw' {
  const contents: string;
  export default contents;
}
