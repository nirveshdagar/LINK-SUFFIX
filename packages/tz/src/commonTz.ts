const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  'en-US': ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver', 'America/Phoenix'],
  'en-GB': ['Europe/London'],
  'en-IN': ['Asia/Kolkata'],
  'en-AU': ['Australia/Sydney', 'Australia/Melbourne'],
  'en-CA': ['America/Toronto', 'America/Vancouver'],
  'de-DE': ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'],
  'fr-FR': ['Europe/Paris'],
  'es-ES': ['Europe/Madrid'],
  'it-IT': ['Europe/Rome'],
  'pt-BR': ['America/Sao_Paulo'],
  'pt-PT': ['Europe/Lisbon'],
  'nl-NL': ['Europe/Amsterdam'],
  'pl-PL': ['Europe/Warsaw'],
  'ru-RU': ['Europe/Moscow'],
  'ja-JP': ['Asia/Tokyo'],
  'zh-CN': ['Asia/Shanghai'],
  'zh-HK': ['Asia/Hong_Kong'],
  'zh-TW': ['Asia/Taipei'],
  'ko-KR': ['Asia/Seoul'],
  'ar-AE': ['Asia/Dubai'],
  'ar-SA': ['Asia/Riyadh'],
  'he-IL': ['Asia/Jerusalem'],
  'tr-TR': ['Europe/Istanbul'],
  'th-TH': ['Asia/Bangkok'],
  'vi-VN': ['Asia/Ho_Chi_Minh'],
  'id-ID': ['Asia/Jakarta'],
  'hi-IN': ['Asia/Kolkata'],
  'ta-IN': ['Asia/Kolkata'],
};

export function commonTzForLocale(locale: string): string {
  const list = CANDIDATES[locale];
  if (list && list.length > 0) {
    return list[Math.floor(Math.random() * list.length)]!;
  }
  return 'UTC';
}
