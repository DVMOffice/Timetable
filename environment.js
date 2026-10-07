// This file is deliberately branch-specific. The staging branch must always
// point at staging; main carries the equivalent production configuration.
// Do not infer the environment from hostname: preview and local hosts must
// never silently connect to production.
(function () {
  'use strict';

  window.TIMETABLE_ENVIRONMENT = Object.freeze({
    name: 'staging',
    adminEmail: 'dvmprogram@ucalgary.ca',
    firebaseConfig: {
      apiKey: 'AIzaSyBaUh041muZ0fPKOBZDTn1rLkQXjgWKP98',
      authDomain: 'ucvm-timetable-staging.firebaseapp.com',
      projectId: 'ucvm-timetable-staging',
      storageBucket: 'ucvm-timetable-staging.firebasestorage.app',
      messagingSenderId: '429769683727',
      appId: '1:429769683727:web:1ce312ed71b48d21dbc47a',
      measurementId: 'G-FYZL2CMF8X'
    }
  });
})();
