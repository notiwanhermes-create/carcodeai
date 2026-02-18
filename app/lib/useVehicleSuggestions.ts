"use client";
import * as React from "react";

// waits until user stops typing for a moment
function useDebounced<T>(value: T, delay = 200) {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}

// returns a list of matching makes (brands)
export function useMakeSuggestions(makeQuery: string) {
  const q = useDebounced(makeQuery, 200);
  const [makes, setMakes] = React.useState<{ id: number; name: string }[]>([]);

  React.useEffect(() => {
    // if user hasn't typed anything, clear suggestions
    if (!q.trim()) {
      setMakes([]);
      return;
    }

    fetch(`/api/vehicles/makes?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((data) => {
        const items = Array.isArray(data.makes) ? data.makes : [];
        setMakes(items);
      })
      .catch(() => setMakes([]));
  }, [q]);

  return makes;
}

// returns a list of matching models for a selected makeId (+ optional year)
export function useModelSuggestions(makeId: number | string | null | undefined, year: string, modelQuery: string) {
  const q = useDebounced(modelQuery, 200);
  const [models, setModels] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!makeId) {
      setModels([]);
      return;
    }

    const url =
      `/api/vehicles/models?makeId=${encodeURIComponent(String(makeId))}` +
      (year.trim() ? `&year=${encodeURIComponent(year.trim())}` : "") +
      `&q=${encodeURIComponent(q)}`;

    fetch(url)
      .then((r) => r.json())
      .then((data) => setModels(Array.isArray(data.models) ? data.models : []))
      .catch(() => setModels([]));
  }, [makeId, year, q]);

  return models;
}
