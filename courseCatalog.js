// courseCatalog.js — Static "Course List" reference data
// Source: VTMD_2025-2026_Courses & Credits.xlsx (columns A-F only; Course Hour / GFC excluded)
// Read-only reference table, unrelated to Firestore session data / courseData.js filter list.

const COURSE_CATALOG = {
  groups: [
    {
      year: 1,
      curriculum: 'New',
      totalLabel: 'Totals',
      total: 30,
      rows: [
        { subArea: 'VTMD', courseNum: '200', name: 'Intro to Veterinary Medicine',        semester: 'Block Fall',   credits: 3 },
        { subArea: 'VTMD', courseNum: '202', name: 'Professional Identity Formation I',    semester: 'Fall',         credits: 3 },
        { subArea: 'VTMD', courseNum: '204', name: 'Exploring Veterinary Medicine I',      semester: 'Fall',         credits: 3 },
        { subArea: 'VTMD', courseNum: '206', name: 'Healthy Animals I',                    semester: 'Fall',         credits: 6 },
        { subArea: 'VTMD', courseNum: '211', name: 'Practical Work Experience I',          semester: 'Block Winter', credits: 3 },
        { subArea: 'VTMD', courseNum: '213', name: 'Animals As Populations',               semester: 'Winter',       credits: 3 },
        { subArea: 'VTMD', courseNum: '215', name: 'What Is A Veterinarian',               semester: 'Winter',       credits: 3 },
        { subArea: 'VTMD', courseNum: '217', name: 'Healthy Animals II',                   semester: 'Winter',       credits: 6 },
      ],
    },
    {
      year: 2,
      curriculum: 'New',
      totalLabel: 'Total',
      total: 30,
      rows: [
        { subArea: 'VTMD', courseNum: '302', name: 'Professional Identity Formation II',                    semester: 'Fall',         credits: 6 },
        { subArea: 'VTMD', courseNum: '304', name: 'Science of What Goes Wrong I',                           semester: '6-wk Fall',    credits: 3 },
        { subArea: 'VTMD', courseNum: '306', name: 'Science of What Goes Wrong II',                          semester: '6-wk Fall',    credits: 3 },
        { subArea: 'VTMD', courseNum: '308', name: 'Fundamentals of Diagnosis, Management and Treatment',    semester: 'Fall',         credits: 3 },
        { subArea: 'VTMD', courseNum: '311', name: 'Practical Work Experience II',                           semester: 'Block Winter', credits: 3 },
        { subArea: 'VTMD', courseNum: '313', name: 'Veterinarians in Society',                                semester: 'Winter',       credits: 3 },
        { subArea: 'VTMD', courseNum: '315', name: 'Sick Animals - Head, oral, GIT',                          semester: '4-wk Winter',  credits: 3 },
        { subArea: 'VTMD', courseNum: '317', name: 'Sick Animals - Endocrine, Renal, Reproduction',           semester: '4-wk Winter',  credits: 3 },
        { subArea: 'VTMD', courseNum: '319', name: 'Sick Animals - Neonate, Special Senses, Alternative species', semester: '4-wk Winter', credits: 3 },
      ],
    },
    {
      year: 3,
      curriculum: 'Legacy',
      totalLabel: 'Total',
      total: 30,
      rows: [
        { subArea: 'VETM', courseNum: '440', name: 'One Health and Veterinary Practice',                                                           semester: 'Fall Block Week', credits: 1.5 },
        { subArea: 'VETM', courseNum: '501', name: 'Clinical Presentations III',                                                                    semester: 'All year',        credits: 2.75 },
        { subArea: 'VETM', courseNum: '505', name: 'Clinical Skills III',                                                                            semester: 'All year',        credits: 7 },
        { subArea: 'VETM', courseNum: '506', name: 'Investigative Veterinary Medicine and Science Communication',                                   semester: 'All year',        credits: 1.5 },
        { subArea: 'VETM', courseNum: '508', name: 'Professional Skills III',                                                                        semester: 'All year',        credits: 1.5 },
        { subArea: 'VETM', courseNum: '521', name: 'Equine Medicine and Surgery',                                                                    semester: 'All year',        credits: 2.5 },
        { subArea: 'VETM', courseNum: '522', name: 'Small Animal Medicine and Surgery',                                                              semester: 'All year',        credits: 2.5 },
        { subArea: 'VETM', courseNum: '523', name: 'Anesthesiology and Therapeutics',                                                                semester: 'Fall',            credits: 1.5 },
        { subArea: 'VETM', courseNum: '525', name: 'Advanced Health Management',                                                                     semester: 'Winter',          credits: 2 },
        { subArea: 'VETM', courseNum: '530', name: 'Selected Topics in Clinical Medicine',                                                           semester: 'Winter',          credits: 0.75 },
        { subArea: 'VETM', courseNum: '531', name: 'Selected Topics in Small Ruminant, South American Camelid and Non-traditional Livestock Production', semester: 'Winter',       credits: 0.75 },
        { subArea: 'VETM', courseNum: '540', name: 'Food Animal Medicine and Surgery',                                                               semester: 'Fall',            credits: 2 },
        { subArea: 'VETM', courseNum: '541', name: 'Theriogenology',                                                                                  semester: 'Fall',            credits: 1.5 },
        { subArea: 'VETM', courseNum: '542', name: 'Emergency and Critical Care',                                                                     semester: 'Fall',            credits: 0.75 },
        { subArea: 'VETM', courseNum: '550', name: 'Zoological Medicine',                                                                             semester: 'Fall',            credits: 0.75 },
        { subArea: 'VETM', courseNum: '551', name: 'Laboratory Animal Medicine',                                                                      semester: 'Winter',          credits: 0.75 },
      ],
    },
  ],
};

window.COURSE_CATALOG = COURSE_CATALOG;
