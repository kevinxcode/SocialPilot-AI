/**
 * A selector is a CSS query plus optional text/aria-label regex filters (case-insensitive).
 * Arrays are tried in order — first match wins — so a Meta UI change is fixed by editing one config file.
 */
export interface Sel {
  css: string;
  /** regex source matched against the element's visible text (trimmed) */
  text?: string;
  /** regex source matched against aria-label of the element or a descendant svg */
  label?: string;
}

export interface PlatformSelectors {
  platform: 'threads' | 'facebook' | 'fbgroup';
  version: string;
  /** any match ⇒ logged out */
  loggedOut: Sel[];
  /** identity proof on own profile/page (e.g. "Edit profile" button) */
  ownProfileProof: Sel[];
  /** shown to non-members of a group */
  notMember?: Sel[];
  /** notice that a post awaits admin approval (groups) */
  pendingNotice?: Sel[];
  /** prompt to switch into the Page (Facebook) */
  switchToPage?: Sel[];
  /** composer opener when acting as the account/page */
  composerOpen: Sel[];
  composerDialog: Sel[];
  textbox: Sel[];
  mediaButton?: Sel[];
  fileInput: Sel[];
  mediaPreview: Sel[];
  nextButton?: Sel[];
  /** Threads: "Community or topic" field next to the author name */
  topicField?: Sel[];
  /** suggestions shown after typing a topic */
  topicOption?: Sel[];
  postButton: Sel[];
  /** containers holding one post each in the profile/page feed */
  postContainer: string;
  /** regex source for permalink hrefs */
  permalink: string;
}
