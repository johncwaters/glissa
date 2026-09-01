declare const __APP_VERSION__: string;

declare module '*.css';

declare module '*?raw' {
  const contents: string;
  export default contents;
}
