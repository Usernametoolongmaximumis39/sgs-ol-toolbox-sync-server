// Optional for existing packages; when present it describes this exact version.
export const validReleaseNotes = value => value === undefined || (typeof value === 'string'
  && value.trim().length > 0 && value.length <= 2000
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
