type GothicTerm =
  | 'Necromancer'
  | 'Skeleton'
  | 'Grimoire'
  | 'Pact'
  | 'Death_Certificate'
  | 'Legion'
  | 'Reliquary'
  | 'Lay_to_rest';

const ERROR_DESCRIPTIONS: Record<string, string> = {
  BAD_URL: 'The repository URL is invalid or malformed.',
  REPO_EMPTY: 'The repository default branch contains no commits.',
  REPO_NOT_FOUND: 'The repository was not found or is private.',
  GITHUB_UNAVAILABLE: 'GitHub services are temporarily unavailable.',
  RATE_LIMITED: 'The GitHub API rate limit was exceeded.',
  TOO_LARGE: 'The repository archive exceeds size limits.',
  ARCHIVE_UNSAFE: 'The repository archive contains unsafe paths or links.',
  TIMEOUT: 'The operation timed out.',
  LANGUAGE_UNKNOWN: 'No supported programming language was detected.',
};

// Requirement 47.4, Task 3.3
export const glossary: Record<GothicTerm, string> = {
  Necromancer:
    'The Node/TypeScript planner service that owns planning, scheduling and every policy decision of a live run.',
  Skeleton:
    'One kiro-cli session with a role-specific custom agent, raised by the Necromancer for one role and task.',
  Grimoire:
    'The deterministic rule engine for rules M1 to M6 (detection, dead or alive, migration guidance, Grimoire bundle).',
  Pact:
    'The plan for one repository: requirements.md, design.md and tasks.md written by the Planner and approved by the user.',
  Death_Certificate:
    'The stored baseline result of install, build and test on the base sha, with the Exhumer\'s failure classes.',
  Legion:
    'The set of live Skeletons in a run.',
  Reliquary:
    'The results page of a run.',
  Lay_to_rest:
    'Stopping a Skeleton; its task becomes abandoned.',
};

// Requirement 47.5, Task 3.3
export const KIRO_ROLE_SENTENCE = 'Skeleton sessions run on Kiro CLI.';

// Requirement 37, Requirement 47.6, Task 3.3
export const GATE_FOOTER =
  'Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project.';

// Requirement 47.3, Task 3.3
export function formatPlainError(code: string, nextAction: string): string {
  const whatHappened =
    ERROR_DESCRIPTIONS[code] ??
    ERROR_DESCRIPTIONS[code.toUpperCase()] ??
    'An unexpected error occurred.';
  return `Error code: ${code}. What happened: ${whatHappened} What to do next: ${nextAction}`;
}
