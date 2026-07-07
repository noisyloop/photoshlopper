import type { ToolId } from '../types';
import type { Tool } from './framework';
import { brushTool, eraserTool, cloneTool } from './paint';
import { marqueeTool, lassoTool, wandTool } from './select';
import { eyedropperTool, bucketTool, gradientTool } from './fill';
import { handTool, zoomTool, moveTool, cropTool } from './nav';
import { shapeTool, typeTool } from './shape';

export const TOOLS: Record<ToolId, Tool> = {
  move: moveTool,
  marquee: marqueeTool,
  lasso: lassoTool,
  wand: wandTool,
  crop: cropTool,
  eyedropper: eyedropperTool,
  brush: brushTool,
  eraser: eraserTool,
  bucket: bucketTool,
  gradient: gradientTool,
  clone: cloneTool,
  type: typeTool,
  shape: shapeTool,
  hand: handTool,
  zoom: zoomTool,
};

export const TOOL_INFO: Array<{ id: ToolId; label: string; key: string; icon: string }> = [
  { id: 'move', label: 'Move', key: 'V', icon: '✥' },
  { id: 'marquee', label: 'Marquee Select', key: 'M', icon: '▭' },
  { id: 'lasso', label: 'Lasso', key: 'L', icon: '➰' },
  { id: 'wand', label: 'Magic Wand', key: 'W', icon: '✨' },
  { id: 'crop', label: 'Crop', key: 'C', icon: '⬚' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I', icon: '💧' },
  { id: 'brush', label: 'Brush', key: 'B', icon: '🖌' },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: '⌫' },
  { id: 'bucket', label: 'Paint Bucket', key: 'G', icon: '🪣' },
  { id: 'gradient', label: 'Gradient', key: 'G', icon: '▤' },
  { id: 'clone', label: 'Clone Stamp', key: 'S', icon: '⎘' },
  { id: 'type', label: 'Type', key: 'T', icon: 'T' },
  { id: 'shape', label: 'Shape', key: 'U', icon: '◆' },
  { id: 'hand', label: 'Hand', key: 'H', icon: '✋' },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: '🔍' },
];
