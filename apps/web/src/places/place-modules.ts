import { createModuleCache } from '../lib/module-cache.ts';
import type { ComponentType } from 'react';
import type { Place } from '../lib/places.ts';

const loaders = {
  inputs: () => import('./InputsPlace.tsx').then((module) => module.InputsPlace),
  trends: () => import('./TrendsPlace.tsx').then((module) => module.TrendsPlace),
  matches: () => import('./MatchesPlace.tsx').then((module) => module.MatchesPlace),
  vocabulary: () => import('./VocabularyPlace.tsx').then((module) => module.VocabularyPlace),
  compare: () => import('./ComparePlace.tsx').then((module) => module.ComparePlace),
} satisfies Record<Place, () => Promise<ComponentType>>;

const modules = createModuleCache<Place, ComponentType>(loaders);
export const resolvedPlace = modules.resolved;
export const loadPlace = modules.load;
