export default function CodesIndexPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold">OBD-II Trouble Codes</h1>
      <p className="mt-3 text-gray-700">
        Search Google for a code and land directly on a code page like{" "}
        <a className="underline" href="/codes/p0300">
          /codes/p0300
        </a>
        .
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3">
        {["P0300", "P0420", "P0171", "P0455", "P0442", "P0128"].map((c) => (
          <a
            key={c}
            className="rounded-lg border p-4 hover:bg-gray-50"
            href={`/codes/${c.toLowerCase()}`}
          >
            <div className="text-lg font-semibold">{c}</div>
            <div className="text-sm text-gray-600">View details</div>
          </a>
        ))}
      </div>
    </main>
  );
}
