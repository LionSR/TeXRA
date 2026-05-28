# Terms of Service

_Effective Date: February 9, 2026_

_Last Updated: May 28, 2026_

---

## 1. Acceptance of Terms

By installing, accessing, or using TeXRA — including the Visual Studio Code extension, any web applications, APIs, desktop or mobile applications, or other software or services we make available now or in the future (collectively, the "Service") — you ("you" or "User") agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, do not install, access, or use the Service.

These Terms are entered into between you and the TeXRA team ("we," "us," or "our"), the individuals developing and operating the Service. References to "TeXRA" refer to the Service and its associated offerings, not a corporate entity.

## 2. Description of Service

TeXRA is an AI-powered platform for LaTeX research and writing. The Service currently includes a Visual Studio Code extension and may expand to include web applications, APIs, and other interfaces. The Service connects to third-party large language model (LLM) providers — including but not limited to Anthropic (Claude), OpenAI (GPT), and Google (Gemini) — to deliver its features.

We reserve the right to modify, suspend, or discontinue the Service (or any part of it) at any time, with or without notice. We shall not be liable to you or any third party for any modification, suspension, or discontinuation of the Service.

## 3. Eligibility

You must be at least 18 years old, or the age of legal majority in your jurisdiction, to use the Service. By using TeXRA, you represent that you meet this requirement.

## 4. License Grant

Subject to your compliance with these Terms, we grant you a limited, non-exclusive, non-transferable, non-sublicensable, revocable license to install and use the Service for your personal or internal business purposes. This license does not include the right to:

1. Modify, adapt, or create derivative works of the Service.
2. Distribute, sublicense, lease, lend, or sell the Service to any third party.
3. Use the Service to build a competing product or service.

We reserve all rights not expressly granted in these Terms.

## 5. User Accounts and API Keys

- **API Keys**: Certain features require you to provide your own API keys for third-party AI providers. You are solely responsible for obtaining, maintaining, and securing your API keys. API keys are stored locally using VS Code's built-in Secret Storage and are never transmitted to TeXRA servers. See Section 9 for details on how data is handled in this mode.
- **Researcher Access Program**: TeXRA may offer access programs that provide limited access to AI models without requiring personal API keys. When using this program, requests are routed through a TeXRA-operated relay server (see Section 9 for details). Participation is limited to personal research and academic use, is subject to fair-use limits, and may be modified or discontinued at any time.
- **Account Integrity**: You may only create and operate one account for your own personal use. To prevent abuse of free and Researcher Access tier resources, sign-up may be restricted by automated checks on the email address and the underlying identity provider account. In particular, we may reject sign-ups that:
  1. use a disposable, temporary, or throwaway email provider;
  2. use a privacy / forwarding-only email provider that has been disproportionately associated with abuse;
  3. authenticate through a third-party identity provider account (e.g., a GitHub account) that was created very recently (typically within the last 30 days) or that otherwise has no meaningful prior history.

  You agree to sign up using your primary institutional, employer, or long-term personal email address and a primary identity-provider account, rather than a newly-created or disposable account. If you have a legitimate need for an exception (for example, you are a researcher whose only available address is a privacy-relay email), you may contact contact@texra.ai to request manual approval.

## 6. Acceptable Use

You agree not to use the Service to:

1. Violate any applicable law, regulation, or third-party rights.
2. Generate, submit, or distribute content that is unlawful, harmful, threatening, abusive, defamatory, or otherwise objectionable.
3. Infringe upon intellectual property rights of any party.
4. Interfere with or disrupt the Service or any connected services.
5. Attempt to reverse-engineer, decompile, or disassemble the Service beyond what applicable law expressly permits.
6. Circumvent any access controls, rate limits, or usage restrictions.
7. Use the Service for automated bulk processing in a manner that abuses third-party API services.
8. Misrepresent AI-generated content as solely human-authored in contexts where disclosure is required.
9. Create more than one account, or use disposable, temporary, throwaway, privacy-relay, or other newly-created or pseudonymous email or identity-provider accounts in order to obtain additional free or Researcher Access Program resources, or otherwise to circumvent per-user fair-use limits ("multi-accounting"). Accounts found to engage in such conduct, together with any other accounts we reasonably believe to be operated by the same person, may be suspended or terminated without notice and without refund. Quotas and credits associated with such accounts are forfeit.

## 7. Intellectual Property

- **Service**: TeXRA is proprietary software. All rights, title, and interest in the Service, including its code, design, documentation, and trademarks, are owned by the TeXRA team (and will be assigned to any successor entity upon incorporation). These Terms do not grant you any rights to use our trademarks, trade names, or branding.
- **Your Content**: You retain full ownership of all LaTeX documents, research materials, and other content you process through the Service ("Your Content"). We do not claim any ownership rights over Your Content.

## 8. Feedback

If you voluntarily provide suggestions, ideas, enhancement requests, or other feedback regarding the Service ("Feedback"), we may use that Feedback to improve the Service without any obligation or compensation to you. You are never required to provide Feedback.

## 9. Privacy and Data Handling

- **Personal API Keys (Local Processing)**: When you use your own API keys, all calls to AI providers are made directly from your local device to the provider's endpoints. In this mode, your document content is not sent to or routed through TeXRA servers. Your API keys are stored locally (e.g., via VS Code's built-in Secret Storage or equivalent platform-specific secure storage) and are never transmitted to us.
- **Researcher Access Program (Relay Processing)**: When you use the Researcher Access Program (server-side keys), your requests are routed through a TeXRA-operated relay server (`remote.texra.ai`) before being forwarded to the AI provider. In this mode, your document content temporarily passes through our relay infrastructure in order to authenticate the request. We do not read, analyze, or permanently store Your Content on the relay — it transits our servers solely for the purpose of forwarding the request to the AI provider.
- **Third-Party Providers**: In both modes, your content is ultimately transmitted to the respective AI provider's API endpoints. You are responsible for reviewing and accepting the privacy policies and terms of service of your chosen AI provider(s).
- **Telemetry**: When you are signed in to TeXRA (e.g., through the Researcher Access Program), the Service collects anonymized usage metadata — such as model name, token counts, estimated cost, and response time — to monitor service health and improve the product. Telemetry does not include Your Content. If you are not signed in, no telemetry data is collected or transmitted.

## 10. AI and Machine Learning

- **No Model Training on Your Content**: We do not use Your Content to train, fine-tune, or improve any machine learning models. Your Content is processed solely to provide you with the requested AI-assisted features.
- **Third-Party AI Providers**: Each AI provider has its own data usage policies. Some providers may use API inputs for model improvement unless you opt out. We strongly recommend reviewing the data policies of your chosen provider(s):
  - [Anthropic Acceptable Use Policy](https://www.anthropic.com/legal/aup)
  - [OpenAI Usage Policies](https://openai.com/policies/usage-policies)
  - [Google Gemini API Terms of Service](https://ai.google.dev/gemini-api/terms)
- **AI Output Disclaimer**: AI-generated content may contain errors, inaccuracies, hallucinations, or biases. You are solely responsible for reviewing, verifying, and validating all AI-generated outputs before use in research, publications, or any other context. AI outputs do not constitute professional, academic, legal, or any other form of advice.

## 11. Third-Party Services

The Service integrates with third-party services, including AI model providers and OpenRouter. We are not responsible for the availability, accuracy, or content of these third-party services. Your use of third-party services is governed by their respective terms and policies. We may add, remove, or change supported third-party integrations at any time.

## 12. International Data Transfers

The Service supports AI providers headquartered in various jurisdictions worldwide, including providers based outside the European Union and the United States. Some supported providers operate in jurisdictions that may not provide the same level of data protection as your home country or the EU/EEA. By selecting a provider, you acknowledge and consent to your data being transmitted to and processed in the jurisdiction where that provider operates, subject to that jurisdiction's local laws.

A current list of supported providers and their operating jurisdictions is available at [https://texra.ai/providers](https://texra.ai/providers). This list may be updated from time to time as providers are added or removed.

**You are solely responsible for ensuring that your use of any AI provider complies with applicable data protection laws in your jurisdiction**, including but not limited to the EU General Data Protection Regulation (GDPR), the UK GDPR, the California Consumer Privacy Act (CCPA), and any institutional or organizational data policies that apply to you. If you are subject to regulations that restrict international data transfers, you should only select providers that meet your compliance requirements. We do not make any representations regarding the data protection practices of third-party AI providers.

## 13. Free and Beta Services

Certain features of the Service, including the Researcher Access Program, may be offered free of charge or in beta. These features are provided without any service level commitments and may be modified, suspended, or discontinued at any time without notice. We make no guarantees regarding availability, uptime, or continued support for free or beta features.

## 14. Assumption of Risk

You acknowledge that:

1. **AI Outputs**: AI-generated content is inherently unpredictable and may be inaccurate, incomplete, or unsuitable. You assume all risk associated with your reliance on AI-generated outputs, including in academic publications, professional work, or any other context.
2. **API Costs**: When using your own API keys, you are solely responsible for any charges incurred from third-party AI providers. We have no control over and accept no responsibility for third-party pricing, rate limits, or billing disputes.
3. **Data Loss**: While the Service operates on your local files, you are responsible for maintaining your own backups. We are not liable for any data loss or corruption arising from use of the Service.

## 15. Disclaimer of Warranties

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AND QUIET ENJOYMENT.

We do not warrant that:

1. The Service will meet your specific requirements.
2. The Service will be uninterrupted, timely, secure, or error-free.
3. AI-generated outputs will be accurate, complete, or suitable for any particular purpose.
4. Any defects in the Service will be corrected.
5. The Service will be compatible with any particular third-party software, hardware, or AI provider.
6. Third-party AI providers will remain available or maintain their current terms.

YOU USE THE SERVICE AT YOUR OWN RISK. THE ENTIRE RISK AS TO SATISFACTORY QUALITY, PERFORMANCE, ACCURACY, AND EFFORT IS WITH YOU.

## 16. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE TEXRA TEAM OR ITS MEMBERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, USE, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICE, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), OR ANY OTHER LEGAL THEORY, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

WITHOUT LIMITING THE FOREGOING, WE SHALL NOT BE LIABLE FOR ANY DAMAGES ARISING FROM: (A) THIRD-PARTY AI PROVIDER OUTAGES, CHANGES IN TERMS, OR DISCONTINUATION OF SERVICES; (B) INACCURATE, MISLEADING, OR HARMFUL AI-GENERATED CONTENT; (C) UNAUTHORIZED ACCESS TO YOUR API KEYS OR CONTENT CAUSED BY YOUR FAILURE TO SECURE YOUR CREDENTIALS; (D) ANY ACTIONS TAKEN BASED ON AI-GENERATED OUTPUTS; OR (E) INTERNATIONAL DATA TRANSFERS TO THIRD-PARTY AI PROVIDERS YOU SELECT.

Our total cumulative liability to you for all claims arising from or related to the Service shall not exceed the greater of (a) the amount you have paid to us, if any, for access to the Service during the twelve (12) months preceding the claim, or (b) fifty US dollars (USD $50).

## 17. Indemnification

To the extent permitted by applicable law, you agree to hold harmless the TeXRA team and its members from any claims, liabilities, damages, or expenses (including reasonable attorneys' fees) arising from: (a) your violation of these Terms, (b) your infringement of any third-party rights, or (c) your use of the Service in a manner not authorized by these Terms.

## 18. Dispute Resolution

- **Informal Resolution**: Before filing any formal legal claim, you agree to first contact us at contact@texra.ai and attempt to resolve the dispute informally for at least thirty (30) days.
- **Arbitration**: If the dispute cannot be resolved informally, either party may elect to resolve the dispute through binding arbitration administered under the rules of a mutually agreed-upon arbitration body. Arbitration shall be conducted on an individual basis; class arbitrations and class actions are not permitted. If for any reason a claim proceeds in court rather than through arbitration, each party waives any right to a jury trial.
- **Exceptions**: Either party may seek injunctive or other equitable relief in any court of competent jurisdiction to prevent the actual or threatened infringement or misappropriation of intellectual property rights.

## 19. Modifications to the Terms

We reserve the right to update or modify these Terms at any time. Material changes will be communicated through the Service, our website, or other reasonable means (e.g., via an in-app notification, changelog entry, or email) or by updating the "Last Updated" date at the top of this document. Your continued use of the Service after any modifications constitutes acceptance of the revised Terms. We encourage you to review these Terms periodically.

## 20. Termination

We may suspend or terminate your access to the Service if you violate these Terms, or for any other reason with reasonable notice. In urgent circumstances (such as abuse, fraud, or legal requirements), we may act immediately without prior notice. You may stop using the Service at any time by uninstalling it or ceasing to access it. Upon termination, all rights and licenses granted to you under these Terms will immediately cease. Sections 7, 8, 10, 12, 14, 15, 16, 17, 18, 21, and 22 shall survive termination.

## 21. Governing Law

These Terms shall be governed by and construed in accordance with the laws of the State of California, United States, without regard to conflict of law principles and without regard to the United Nations Convention on Contracts for the International Sale of Goods. To the extent litigation is permitted under these Terms, the exclusive venue shall be the state or federal courts located in San Francisco County, California.

## 22. Assignment

You may not assign or transfer these Terms or any rights hereunder without our prior written consent. We may freely assign these Terms, including to any successor entity formed upon incorporation, merger, acquisition, or reorganization, without restriction or notice. Any attempted assignment in violation of this section shall be null and void.

## 23. Force Majeure

We shall not be liable for any failure or delay in performing our obligations under these Terms where such failure or delay results from circumstances beyond our reasonable control, including but not limited to natural disasters, acts of government, pandemic, internet or infrastructure outages, third-party service disruptions, or changes to third-party AI provider terms or availability.

## 24. No Third-Party Beneficiaries

These Terms do not confer any rights, remedies, or benefits on any third party. No third party shall have any right to enforce any provision of these Terms.

## 25. Waiver

Our failure to enforce any right or provision of these Terms shall not constitute a waiver of such right or provision. Any waiver of any provision of these Terms will be effective only if in writing and signed by us.

## 26. Severability

If any provision of these Terms is found to be unenforceable or invalid, that provision shall be limited or eliminated to the minimum extent necessary so that these Terms shall otherwise remain in full force and effect.

## 27. Entire Agreement

These Terms, together with any additional terms you agree to when using particular features of the Service, constitute the entire agreement between you and the TeXRA team regarding the Service and supersede all prior agreements and understandings.

## 28. Contact

If you have questions or concerns about these Terms, please contact us:

- **Email**: contact@texra.ai
- **GitHub**: [https://github.com/texra-ai/texra-issues](https://github.com/texra-ai/texra-issues)
- **Website**: [https://texra.ai](https://texra.ai)
