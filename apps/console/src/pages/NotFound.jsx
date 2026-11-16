// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link } from 'react-router-dom';
import { Btn, Card, PageTitle } from '../components/ui.jsx';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 pt-24">
      <PageTitle title="Page not found" sub="The page or route does not exist." />
      <Card>
        <p className="text-sm text-normal-text">
          Check the URL, or return to the console. If you followed a link from inside SynapseOne, report the broken path.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/"><Btn kind="secondary">Home</Btn></Link>
          <Link to="/dashboard"><Btn>Open console</Btn></Link>
          <Link to="/login" className="text-sm text-main-blue self-center">Sign in</Link>
        </div>
      </Card>
    </div>
  );
}
