/// <reference types="vite/client" />

declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

declare module '*?inline' {
  const content: string;
  export default content;
}
