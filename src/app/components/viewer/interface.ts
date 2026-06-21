import { CasePayload, CaseView, ClassInfo, ClassStyle, MaskOverlay } from '../../types';

/** Per-class state — only the data (path, color, visibility flag). Style
 * controls live at the component level since they're shared across classes. */
export interface OverlayState {
  classId: number;
  name: string;
  visible: boolean;
  pathD: string;
  baseStyle: ClassStyle;        // resolved default (from class + project override)
  swatch: string;                // color used in chip + applied to stroke/fill
  isOpticDisc: boolean;
  geom: { cx: number; cy: number; r: number } | null;
}
 
export interface EtdrsRings {
  cx: number;
  cy: number;
  ddRadii: number[];
  pxRadii: number[];
}
 
export interface ViewState {
  view: 'macula' | 'od';
  loaded: boolean;
  width: number;
  height: number;
  overlays: OverlayState[];
  etdrs: EtdrsRings | null;
  scale: number;
  tx: number;
  ty: number;
}
 
/** Render style for an overlay group — applied to every member class. */
export interface GroupStyle {
  fillOpacity: number;
  strokeWidth: number;
  strokeOpacity: number;
  animate: 'none' | 'march' | 'pulse';
}
 
export interface EtdrsConfig {
  visible: boolean;
  ddRadii: number[];
  strokeColor: string;
  strokeWidth: number;
  strokeOpacity: number;
  dashed: boolean;
}
 