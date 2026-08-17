export type UaFamily =
  | 'iphone'
  | 'ipad'
  | 'android'
  | 'mac-safari'
  | 'mac-chrome'
  | 'windows-chrome'
  | 'windows-edge';

export type Continent = 'NA' | 'EU' | 'AS' | 'OC' | 'SA' | 'AF';

export interface BuildRange {
  minMajor: number;
  maxMajor: number;
  minMinor: number;
  maxMinor: number;
}

export interface UaTemplate {
  id: string;
  family: UaFamily;
  uaPattern: string;
  buildRange: BuildRange;
  viewport: { w: number; h: number; dpr: number };
  hardware: { cores: [number, number]; memoryGb: [number, number] };
  webgl: { vendors: string[]; renderers: string[] };
  locale: string;
  languages: string[];
  cityAffinity: Continent[];
}

export interface SynthesizedFingerprint {
  templateId: string;
  ua: string;
  build: string;
  fingerprint: {
    viewport: { w: number; h: number; dpr: number };
    hardware: { cores: number; memoryGb: number };
    webgl: { vendor: string; renderer: string };
    locale: string;
    languages: string[];
    timezone: string;
  };
}