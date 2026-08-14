export interface InputResetCopy {
  readonly accessibleName: string;
  readonly confirmation: string;
  readonly notice: string;
}

function itemLabel(texts: number, terms: number): string {
  return [
    texts > 0 ? `${texts} active text${texts === 1 ? '' : 's'}` : null,
    terms > 0 ? `${terms} term${terms === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null).join(' and ');
}

export function inputResetCopy(texts: number, terms: number): InputResetCopy {
  const items = itemLabel(texts, terms);
  const libraryConfirmation = texts > 0
    ? '\n\nSaved texts will remain in the local library.'
    : '';
  const libraryNotice = texts > 0
    ? ' Saved texts remain in the local library.'
    : '';
  return {
    accessibleName: texts > 0 && terms === 0
      ? 'Clear all active inputs'
      : texts === 0 && terms > 0
        ? 'Clear all terms'
        : 'Clear all active inputs and terms',
    confirmation: items === '' ? '' : `Clear ${items}?${libraryConfirmation}`,
    notice: items === '' ? '' : `${items} cleared.${libraryNotice}`,
  };
}
