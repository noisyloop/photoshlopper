// Tool framework: each tool is a module with pointer handlers, a cursor and
// an optional overlay draw. The Canvas component converts pointer events to
// doc coordinates and routes them here.

export interface PointerInfo {
  docX: number;
  docY: number;
  viewX: number;
  viewY: number;
  pressure: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface ViewInfo {
  zoom: number;
  panX: number;
  panY: number;
  docToView: (x: number, y: number) => [number, number];
}

export interface Tool {
  cursor: string;
  onDown(p: PointerInfo): void;
  onMove(p: PointerInfo, buttonDown: boolean): void;
  onUp(p: PointerInfo): void;
  /** draw tool feedback in VIEW space (ctx is the on-screen canvas) */
  drawOverlay?(ctx: CanvasRenderingContext2D, view: ViewInfo): void;
}
