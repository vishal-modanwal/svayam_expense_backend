/**
 * Normalize MariaDB connector SELECT results to a flat array of row objects.
 * Handles occasional `[[...rows]]` nesting seen with some query paths.
 */
export function selectRowArray(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) return [];
    if (raw.length === 1 && Array.isArray(raw[0])) return raw[0];
    return raw;
}

/** True when DB error is unknown column related to `archived` (migration not applied). */
export function isMissingArchivedColumnError(err) {
    const msg = String(err?.message ?? "");
    return (
        (err?.errno === 1054 || err?.sqlState === "42S22") &&
        /\b(archived|archive_reason|deleted_at|deleted_by)\b/i.test(msg)
    );
}

/** @deprecated Use isMissingArchivedColumnError — legacy `deleted_at` migrations */
export function isMissingDeletedAtColumnError(err) {
    const msg = String(err?.message ?? "");
    return (err?.errno === 1054 || err?.sqlState === "42S22") && /deleted_at/i.test(msg);
}
