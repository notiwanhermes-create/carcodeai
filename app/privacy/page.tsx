export const metadata = { title: "Privacy Policy | CarCode AI" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-semibold">Privacy Policy</h1>
      <p className="mt-2 text-sm opacity-80">Effective date: October 14, 2026</p>

      <div className="prose prose-invert mt-8 max-w-none">
        <p>
          CarCode AI (&quot;CarCode AI&quot;, &quot;we&quot;, &quot;us&quot;) provides vehicle troubleshooting and
          diagnostic information through our website (the &quot;Service&quot;). This Privacy Policy
          explains what information we collect, how we use it, and your choices.
        </p>

        <h2>1) Information we collect</h2>
        <h3>A. Account information (if you create an account)</h3>
        <ul>
          <li>Email address</li>
          <li>Name (first/last name), if provided</li>
          <li>Profile image, if you sign in with Google</li>
          <li>Authentication identifiers (e.g., Google account ID)</li>
        </ul>

        <h3>B. Login and session data</h3>
        <ul>
          <li>Session cookies and session identifiers used to keep you signed in</li>
          <li>Basic security logs related to authentication (e.g., failed sign-in attempts)</li>
        </ul>

        <h3>C. Usage information</h3>
        <ul>
          <li>Pages viewed and basic interaction data</li>
          <li>Approximate location and device/browser details may be inferred from IP by analytics</li>
        </ul>

        <h3>D. Diagnostic inputs you provide</h3>
        <ul>
          <li>
            Information you type into the Service (e.g., symptoms, DTC/OBD codes, vehicle details like make/model/year)
          </li>
        </ul>
        <p>Please avoid entering sensitive personal data into diagnostic fields.</p>

        <h3>E. Your garage, if you are signed in</h3>
        <p>When you are signed in, we store the following in your account so you can come back to it:</p>
        <ul>
          <li>Vehicles you save (for example year, make, model, trim, engine, nickname and VIN, if you enter them)</li>
          <li>Maintenance and service records, including the dates, costs and notes you enter</li>
          <li>Mileage readings, where you provide them</li>
          <li>Your diagnosis history: what you entered, the result you were shown, and your answers to follow-up questions</li>
          <li>
            Whether an issue is open, resolved or dismissed, and the repairs you report, including repairs you later say did
            not fix the problem
          </li>
        </ul>

        <h3>F. If you use the Service without signing in</h3>
        <p>
          Vehicles, service records and diagnoses you save without an account are kept in your browser&apos;s storage on your
          device, not in our database. They stay there until you import them into an account after signing in, remove them,
          or clear your browser&apos;s data. What you submit for a diagnosis is still sent to us to produce the answer.
        </p>

        <h2>2) How we use information</h2>
        <ul>
          <li>Provide and operate the Service</li>
          <li>Create and manage your account and sign-in sessions</li>
          <li>Respond to requests and provide support</li>
          <li>Improve the Service (analytics, troubleshooting, performance)</li>
          <li>Detect, prevent, and address fraud, abuse, or security issues</li>
          <li>Comply with legal obligations</li>
        </ul>

        <h2>3) Cookies</h2>
        <p>
          We use cookies for authentication, security, and analytics. You can control cookies through your browser settings.
        </p>

        <h2>4) Sharing of information</h2>
        <p>We do not sell your personal information.</p>
        <p>We may share information with service providers (hosting, databases, analytics, and the AI provider that generates diagnoses from what you enter), authentication providers (Google sign-in), for legal/safety reasons, or during a business transfer.</p>

        <h2>5) Data retention</h2>
        <p>We keep personal information as long as necessary to provide the Service and for legitimate business purposes.</p>
        <p>
          Your saved vehicles and their history stay in your account until you delete them or ask us to delete your
          account. Removing a vehicle from your garage archives it, and nothing is deleted. You can then delete an archived
          vehicle permanently, which deletes it together with its service records, diagnoses and reported repairs. Copies
          may remain in backups.
        </p>

        <h2>6) Your choices and rights</h2>
        <p>
          Depending on where you live, you may have rights to access, correct, or delete your personal information.
          Contact: <strong>support@carcodeai.com</strong>.
        </p>

        <h2>7) Security</h2>
        <p>We use reasonable measures to protect information. No method is 100% secure.</p>

        <h2>8) Children&apos;s privacy</h2>
        <p>The Service is not intended for children under 13.</p>

        <h2>9) International users</h2>
        <p>Your information may be processed in other countries.</p>

        <h2>10) Changes</h2>
        <p>We may update this Privacy Policy and will update the effective date.</p>

        <h2>11) Contact</h2>
        <p>Email: <strong>support@carcodeai.com</strong></p>
      </div>
    </main>
  );
}
