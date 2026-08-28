import type { UaTemplate } from './types.js';

const iphoneTpl = (id: string, buildMajor: number, model: string, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'iphone', cityAffinity,
  uaPattern: `Mozilla/5.0 (iPhone; CPU iPhone OS __BUILD__ like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1`,
  buildRange: { minMajor: buildMajor, maxMajor: buildMajor, minMinor: 0, maxMinor: 9 },
  viewport: { w: 390, h: 844, dpr: 3 },
  hardware: { cores: [4, 6], memoryGb: [4, 8] },
  webgl: { vendors: ['Apple Inc.'], renderers: ['Apple GPU'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

const androidTpl = (id: string, buildMajor: number, model: string, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'android', cityAffinity,
  uaPattern: `Mozilla/5.0 (Linux; Android __BUILD__; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36`,
  buildRange: { minMajor: 14, maxMajor: 14, minMinor: 0, maxMinor: 0 },
  viewport: { w: 412, h: 915, dpr: 2.625 },
  hardware: { cores: [6, 8], memoryGb: [6, 12] },
  webgl: { vendors: ['Qualcomm'], renderers: ['Adreno 740'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

const macSafariTpl = (id: string, buildMajor: number, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'mac-safari', cityAffinity,
  uaPattern: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/__BUILD__ Safari/605.1.15`,
  buildRange: { minMajor: buildMajor, maxMajor: buildMajor, minMinor: 0, maxMinor: 9 },
  viewport: { w: 2560, h: 1440, dpr: 2 },
  hardware: { cores: [8, 12], memoryGb: [16, 32] },
  webgl: { vendors: ['Apple Inc.'], renderers: ['Apple M-series GPU'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

const macChromeTpl = (id: string, buildMajor: number, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'mac-chrome', cityAffinity,
  uaPattern: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/__BUILD__ Safari/537.36`,
  buildRange: { minMajor: buildMajor, maxMajor: buildMajor, minMinor: buildMajor === 118 ? 5993 : 6367, maxMinor: buildMajor === 118 ? 5993 : 6367 },
  viewport: { w: 2560, h: 1440, dpr: 2 },
  hardware: { cores: [8, 12], memoryGb: [16, 32] },
  webgl: { vendors: ['Google Inc. (NVIDIA)'], renderers: ['ANGLE (NVIDIA GeForce RTX)'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

const winChromeTpl = (id: string, buildMajor: number, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'windows-chrome', cityAffinity,
  uaPattern: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/__BUILD__ Safari/537.36`,
  buildRange: { minMajor: buildMajor, maxMajor: buildMajor, minMinor: buildMajor === 110 ? 5481 : buildMajor === 118 ? 5993 : 6367, maxMinor: buildMajor === 110 ? 5481 : buildMajor === 118 ? 5993 : 6367 },
  viewport: { w: 1920, h: 1080, dpr: 1 },
  hardware: { cores: [4, 16], memoryGb: [8, 32] },
  webgl: { vendors: ['Google Inc. (NVIDIA)'], renderers: ['ANGLE (NVIDIA GeForce RTX)'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

const winEdgeTpl = (id: string, buildMajor: number, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'windows-edge', cityAffinity,
  uaPattern: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/__BUILD__ Safari/537.36 Edg/__BUILD__`,
  buildRange: { minMajor: buildMajor, maxMajor: buildMajor, minMinor: 0, maxMinor: 99 },
  viewport: { w: 1920, h: 1080, dpr: 1 },
  hardware: { cores: [4, 16], memoryGb: [8, 32] },
  webgl: { vendors: ['Google Inc. (NVIDIA)'], renderers: ['ANGLE (NVIDIA GeForce RTX)'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

const ipadTpl = (id: string, buildMajor: number, model: string, locale: string, cityAffinity: UaTemplate['cityAffinity']): UaTemplate => ({
  id, family: 'ipad', cityAffinity,
  uaPattern: `Mozilla/5.0 (iPad; CPU OS __BUILD__ like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1`,
  buildRange: { minMajor: buildMajor, maxMajor: buildMajor, minMinor: 0, maxMinor: 9 },
  viewport: { w: 1024, h: 1366, dpr: 2 },
  hardware: { cores: [6, 8], memoryGb: [6, 12] },
  webgl: { vendors: ['Apple Inc.'], renderers: ['Apple GPU'] },
  locale,
  languages: locale === 'en-US' ? ['en-US', 'en'] : ['en-IN', 'en'],
});

export const TEMPLATES: readonly UaTemplate[] = [
  // iphone
  iphoneTpl('iphone-15-safari', 17, 'iPhone', 'en-IN', ['AS']),
  iphoneTpl('iphone-15-plus-safari', 17, 'iPhone', 'en-IN', ['AS']),
  iphoneTpl('iphone-15-pro-safari', 17, 'iPhone', 'en-US', ['NA','AS']),
  iphoneTpl('iphone-15-pro-max-safari', 17, 'iPhone', 'en-US', ['NA','EU']),
  iphoneTpl('iphone-14-pro-safari', 16, 'iPhone', 'en-GB', ['EU','NA']),
  iphoneTpl('iphone-se-3-safari', 15, 'iPhone', 'en-US', ['NA']),
  // android
  androidTpl('pixel-7-chrome', 14, 'Pixel 7', 'en-US', ['NA','EU']),
  androidTpl('pixel-8-chrome', 14, 'Pixel 8', 'en-IN', ['AS']),
  androidTpl('pixel-8-pro-chrome', 14, 'Pixel 8 Pro', 'en-US', ['NA']),
  androidTpl('samsung-s23-chrome', 14, 'SM-S918B', 'en-GB', ['EU']),
  androidTpl('samsung-s24-chrome', 14, 'SM-S928B', 'en-IN', ['AS']),
  androidTpl('oneplus-11-chrome', 14, 'CPH2449', 'en-US', ['NA','EU']),
  // ipad
  ipadTpl('ipad-air-5-safari', 17, 'iPad', 'en-US', ['NA']),
  ipadTpl('ipad-pro-11-safari', 17, 'iPad', 'en-US', ['NA','EU']),
  ipadTpl('ipad-pro-12-9-safari', 17, 'iPad', 'en-IN', ['AS']),
  ipadTpl('ipad-mini-6-safari', 16, 'iPad', 'en-GB', ['EU']),
  // mac-safari
  macSafariTpl('mac-safari-15', 15, 'en-US', ['NA']),
  macSafariTpl('mac-safari-16', 16, 'en-US', ['NA','EU']),
  macSafariTpl('mac-safari-17', 17, 'en-GB', ['EU']),
  // mac-chrome
  macChromeTpl('mac-chrome-118', 118, 'en-US', ['NA']),
  macChromeTpl('mac-chrome-124', 124, 'en-IN', ['AS']),
  // windows-chrome
  winChromeTpl('windows-chrome-110', 110, 'en-US', ['NA']),
  winChromeTpl('windows-chrome-118', 118, 'en-GB', ['EU']),
  winChromeTpl('windows-chrome-124', 124, 'en-IN', ['AS']),
  // windows-edge
  winEdgeTpl('windows-edge-124', 124, 'en-US', ['NA']),
];
