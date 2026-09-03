// The build marker, in one place so the boot log and /health can never disagree about which
// version is actually serving. Kept has `GET /version` for the same reason: "is my change even
// out there yet" is the first question of every deploy, and guessing at it wastes an evening.
//
// Bump it on every deploy.
export const VERSION = 'pocket-19';
