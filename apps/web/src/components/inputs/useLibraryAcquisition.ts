import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../lib/store-instance.ts';
import { localFileIdentity, localLibrary, type LocalFileInput, type LocalLibraryFile, type LocalLibraryItem, type DamagedLibraryItem } from '../../lib/local-library.ts';
import { libraryOperation } from '../../lib/library-operation.ts';
import { demoLoadNotice, LIBRARY_BUSY_NOTICE, loadDemoCorpus } from '../../lib/demo-loader.ts';
import type { BuiltinCorpusId } from '../../lib/project.ts';

/** Owns the library view and durable acquisition lifecycle across Inputs renders.
 * Mutation leases survive unmount and are released only by the owning operation.
 * Stale inspections cannot overwrite a newer refresh or publish after unmount. */
export function useLibraryAcquisition() {
  const docs = useApp((s) => s.projectSession?.project.data.docs ?? null);
  const imports = useApp((s) => s.projectSession?.imports ?? null);
  const unavailableDocs = useApp((s) => s.unavailableDocs);
  const importFiles = useApp((s) => s.importFiles);
  const removeDocuments = useApp((s) => s.removeDocuments);
  const finalizedDocs = docs ?? [];
  const pendingImports = imports ?? [];
  const claimLibrary = libraryOperation.claim;
  const releaseLibrary = libraryOperation.release;
  const activeIdentityRef = useRef<ReadonlySet<string>>(new Set());
  const pendingActivationRef = useRef(new Set<string>());
  const sawPendingImportsRef = useRef(false);
  const [library, setLibrary] = useState<readonly LocalLibraryItem[]>([]);
  const [damagedLibrary, setDamagedLibrary] = useState<readonly DamagedLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const libraryBusy = useSyncExternalStore(
    libraryOperation.subscribe,
    libraryOperation.isBusy,
    libraryOperation.isBusy,
  );
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [demoLoading, setDemoLoading] = useState<BuiltinCorpusId | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const mounted = useRef(false);
  const refreshLibrary = useCallback(async (clearError = true) => {
    const sequence = ++refreshSequence.current;
    const current = () => mounted.current && sequence === refreshSequence.current;
    try {
      const result = await localLibrary.inspect();
      if (!current()) return;
      setLibrary(result.items);
      setDamagedLibrary(result.damaged);
      if (clearError) setLibraryError(null);
    } catch (error) {
      if (current()) setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current()) setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshSequence.current++; };
  }, []);
  // Startup migration and source publications can update the durable library.
  useEffect(() => { void refreshLibrary(false); }, [docs, refreshLibrary]);
  activeIdentityRef.current = new Set(finalizedDocs.flatMap((doc) => doc.library === undefined ? [] : [doc.library]));
  if (pendingImports.length > 0) sawPendingImportsRef.current = true;
  else if (sawPendingImportsRef.current) {
    pendingActivationRef.current.clear();
    sawPendingImportsRef.current = false;
  }
  const activateUnique = (
    files: readonly LocalLibraryFile[],
    items: readonly LocalLibraryItem[],
  ): { readonly duplicates: number; readonly activated: number; readonly accepted: boolean } => {
    const unique: LocalLibraryFile[] = [];
    const queuedIdentities: string[] = [];
    let duplicates = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const identity = localFileIdentity(item.format, item.contentHash);
      if (activeIdentityRef.current.has(identity) || pendingActivationRef.current.has(identity)) {
        duplicates += 1;
        continue;
      }
      pendingActivationRef.current.add(identity);
      queuedIdentities.push(identity);
      unique.push(files[index]!);
    }
    let activated = 0;
    let accepted = true;
    if (unique.length > 0) {
      try {
        accepted = importFiles(unique);
        if (accepted) activated = unique.length;
      } catch (error) {
        for (const identity of queuedIdentities) pendingActivationRef.current.delete(identity);
        throw error;
      }
      if (!accepted || (useApp.getState().projectSession?.imports.length ?? 0) === 0) {
        for (const identity of queuedIdentities) pendingActivationRef.current.delete(identity);
      }
    }
    return { duplicates, activated, accepted };
  };

  const duplicateNotice = (saved: number, active: number): string | null => {
    const parts: string[] = [];
    if (saved > 0) parts.push(`${saved} already saved`);
    if (active > 0) parts.push(`${active} already active`);
    return parts.length === 0 ? null : `${parts.join(' · ')} — no duplicate added`;
  };

  const acquire = async (
    files: readonly LocalFileInput[],
    activate = true,
    signal?: AbortSignal,
    existingLease?: symbol,
    setNotice: (message: string | null) => void = setLibraryNotice,
  ): Promise<{ readonly ok: boolean; readonly activated: number; readonly firstDocument: string | null }> => {
    if (files.length === 0) return { ok: false, activated: 0, firstDocument: null };
    const claimedHere = existingLease === undefined;
    const lease = existingLease ?? claimLibrary();
    if (lease === null || !libraryOperation.owns(lease)) {
      setNotice(LIBRARY_BUSY_NOTICE);
      return { ok: false, activated: 0, firstDocument: null };
    }
    setLibraryError(null);
    setNotice(null);
    try {
      const results = await localLibrary.add(files);
      await refreshLibrary();
      const savedDuplicates = results.filter((result) => !result.added).length;
      const activation = activate && signal?.aborted !== true
        ? activateUnique(
            await Promise.all(results.map((result) => localLibrary.file(result.item.id))),
            results.map((result) => result.item),
          )
        : { duplicates: 0, activated: 0, accepted: true };
      if (signal?.aborted !== true) {
        setNotice(duplicateNotice(savedDuplicates, activation.duplicates));
      }
      const firstLibrary = results[0]?.item.id;
      const session = useApp.getState().projectSession;
      const firstDocument = firstLibrary === undefined || session === null
        ? null
        : session.project.data.docs.find((doc) => doc.library === firstLibrary)?.doc
          ?? session.imports.find((item) => item.library === firstLibrary)?.doc
          ?? null;
      return {
        ok: signal?.aborted !== true && activation.accepted,
        activated: activation.activated,
        firstDocument,
      };
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
      await refreshLibrary(false); // quota failures may have committed earlier files
      return { ok: false, activated: 0, firstDocument: null };
    } finally {
      if (claimedHere) releaseLibrary(lease);
    }
  };

  const loadDemo = async (id: BuiltinCorpusId) => {
    setDemoLoading(id);
    setDemoError(null);
    setDemoNotice(null);
    try {
      const result = await loadDemoCorpus(id, 'additive', { getState: useApp.getState });
      await refreshLibrary();
      setDemoNotice(demoLoadNotice(result, 'additive'));
    } catch (error) {
      await refreshLibrary(false);
      setDemoError(error instanceof Error ? error.message : String(error));
    } finally {
      setDemoLoading(null);
    }
  };

  const activateSaved = async (id: string) => {
    const lease = claimLibrary();
    if (lease === null) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    const item = library.find((candidate) => candidate.id === id);
    if (item === undefined) {
      setLibraryError('that saved file no longer exists');
      releaseLibrary(lease);
      return;
    }
    const identity = localFileIdentity(item.format, item.contentHash);
    if (activeIdentityRef.current.has(identity) || pendingActivationRef.current.has(identity)) {
      setLibraryNotice('1 already active — no duplicate added');
      releaseLibrary(lease);
      return;
    }
    pendingActivationRef.current.add(identity);
    setLibraryError(null);
    setLibraryNotice(null);
    try {
      const accepted = importFiles([await localLibrary.file(id)]);
      if (!accepted || (useApp.getState().projectSession?.imports.length ?? 0) === 0) {
        pendingActivationRef.current.delete(identity);
      }
    } catch (error) {
      pendingActivationRef.current.delete(identity);
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
    }
  };

  const removeSaved = async (id: IDBValidKey) => {
    const lease = claimLibrary();
    if (lease === null) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    const liveDocuments = finalizedDocs
      .filter((doc) => doc.library === id)
      .map((doc) => doc.doc)
      .concat(pendingImports.filter((item) => item.library === id).map((item) => item.doc))
      .concat(unavailableDocs.filter((item) => item.doc.library === id).map((item) => item.doc.doc));
    const name = library.find((item) => item.id === id)?.name
      ?? damagedLibrary.find((item) => item.key === id)?.name ?? 'this saved text';
    const activeEffect = liveDocuments.length > 0 ? ' It will also be removed from Active inputs.' : '';
    if (!window.confirm(`Delete “${name}” from the local library?${activeEffect} You can import the file again later.`)) {
      releaseLibrary(lease);
      return;
    }
    try {
      const result = await localLibrary.delete(id);
      const removed = [...new Set([...liveDocuments, ...result.removedDocuments])];
      if (removed.length > 0) removeDocuments(removed);
      await refreshLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
    }
  };

  const clearSaved = async () => {
    if (libraryOperation.isBusy()) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    if (library.length === 0 && damagedLibrary.length === 0 && libraryError === null) return;
    const prompt = library.length === 0
      ? 'Delete all saved texts, including damaged items, from the local library?'
      : `Delete all ${library.length} saved text${library.length === 1 ? '' : 's'} from the local library?`;
    if (!window.confirm(prompt)) return;
    const lease = claimLibrary();
    if (lease === null) {
      setLibraryNotice(LIBRARY_BUSY_NOTICE);
      return;
    }
    const liveDocuments = finalizedDocs
      .flatMap((doc) => doc.library === undefined ? [] : [doc.doc])
      .concat(pendingImports.map((item) => item.doc))
      .concat(unavailableDocs.map((item) => item.doc.doc));
    try {
      const result = await localLibrary.clear();
      const removed = [...new Set([...liveDocuments, ...result.removedDocuments])];
      if (removed.length > 0) removeDocuments(removed);
      await refreshLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      releaseLibrary(lease);
    }
  };

  return {
    library, damagedLibrary, libraryLoading, libraryError, libraryNotice, libraryBusy,
    demoLoading, demoError, demoNotice, refreshLibrary, acquire, activateSaved,
    removeSaved, clearSaved, loadDemo,
    clearDemoFeedback: () => { setDemoError(null); setDemoNotice(null); },
  };
}
