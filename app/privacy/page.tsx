export default function PrivacyPolicy() {
  return (
    <main className="min-h-screen bg-[#0f172a] text-white px-6 py-12 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Privacy Policy</h1>
      <p className="text-sm text-slate-400 mb-8">Last updated: February 9, 2026</p>

      <section className="space-y-6 text-slate-300 text-sm leading-relaxed">
        <div>
          <h2 className="text-lg font-semibold text-white mb-2">1. Information We Collect</h2>
          <p>When you create an account, we collect your email address, name, and password (stored securely as a hash). If you sign in with Google, we receive your Google profile information including your name, email, and profile picture.</p>
          <p className="mt-2">We also collect vehicle information you voluntarily provide (year, make, model, engine, VIN) and maintenance records you enter into the app.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-2">2. How We Use Your Information</h2>
          <p>We use your information to:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Provide and maintain your account</li>
            <li>Store your vehicle garage and maintenance records</li>
            <li>Generate AI-powered diagnostic analyses based on your vehicle and symptom data</li>
            <li>Improve our services</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-2">3. Third-Party Services</h2>
          <p>We use the following third-party services:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong>OpenAI</strong> — to process diagnostic queries. Vehicle and symptom data is sent to OpenAI for analysis.</li>
            <li><strong>Google OAuth</strong> — for optional sign-in with Google.</li>
            <li><strong>NHTSA VPIC API</strong> — for vehicle make/model lookups and VIN decoding.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-2">4. Data Storage and Security</h2>
          <p>Your data is stored in a secure PostgreSQL database. Passwords are hashed using bcrypt and are never stored in plain text. Session data is managed with secure, httpOnly cookies.</p>
          <p className="mt-2">Guest users&apos; data is stored locally in the browser and is not transmitted to our servers.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-2">5. Data Retention</h2>
          <p>We retain your account data for as long as your account is active. You may request deletion of your account and associated data at any time by contacting us.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-2">6. Your Rights</h2>
          <p>You have the right to access, update, or delete your personal information. You can manage your vehicles and maintenance records directly in the app, or contact us for account deletion.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-2">7. Contact</h2>
          <p>If you have questions about this Privacy Policy, please contact us through the app.</p>
        </div>
      </section>

      <div className="mt-10">
        <a href="/" className="text-blue-400 hover:text-blue-300 text-sm transition">← Back to CarCode AI</a>
      </div>
    </main>
  );
}
