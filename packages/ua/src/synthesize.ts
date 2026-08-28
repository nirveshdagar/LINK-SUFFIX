import type { SynthesizedFingerprint, UaTemplate } from './types.js';

function pickInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickFrom<T>(arr: readonly T[]): T {
  // noUncheckedIndexedAccess: caller must guarantee arr.length > 0.
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export interface SynthesizeOpts {
  build?: string;
  timezone?: string;
}

export function synthesizeUA(
  template: UaTemplate,
  opts: SynthesizeOpts = {},
): SynthesizedFingerprint {
  const major = pickInt(template.buildRange.minMajor, template.buildRange.maxMajor);
  const minor = pickInt(template.buildRange.minMinor, template.buildRange.maxMinor);
  const generatedBuild = /Android __BUILD__/.test(template.uaPattern)
    ? `${major}`
    : /(?:iPhone OS|CPU OS)/.test(template.uaPattern)
      ? `${major}_${minor}`
      : /(?:Chrome|Edg)\/__BUILD__/.test(template.uaPattern)
        ? `${major}.0.${minor}.${pickInt(40, 199)}`
        : `${major}.${minor}`;
  const requestedBuild = opts.build ?? generatedBuild;
  const build = template.uaPattern.includes('Chrome/') && /^\d+$/.test(requestedBuild)
    ? `${requestedBuild}.0.0.0`
    : requestedBuild;
  const ua = template.uaPattern.replace(/__BUILD__/g, build);
  const cores = pickInt(template.hardware.cores[0], template.hardware.cores[1]);
  const mem = pickInt(template.hardware.memoryGb[0], template.hardware.memoryGb[1]);
  return {
    templateId: template.id,
    ua,
    build,
    fingerprint: {
      viewport: { ...template.viewport },
      hardware: { cores, memoryGb: mem },
      webgl: {
        vendor: pickFrom(template.webgl.vendors),
        renderer: pickFrom(template.webgl.renderers),
      },
      locale: template.locale,
      languages: [...template.languages],
      timezone: opts.timezone ?? 'UTC',
    },
  };
}
