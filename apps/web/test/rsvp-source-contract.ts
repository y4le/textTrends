import type { RsvpPlaybackSource } from '@texttrends/rsvp';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';

// Reader pages must remain structurally assignable to the engine contract.
// If this fails, adapt the boundary deliberately; do not cast at a call site.
declare const readerPage: ReaderPageResultV1;
const rsvpSource: RsvpPlaybackSource = readerPage;
void rsvpSource;
