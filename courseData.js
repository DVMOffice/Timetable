// courseData.js — Pre-loaded course list, organized by program Year
// Used to populate the dependent Year → Course dropdown in the submission form.

const CourseData = (() => {

  const COURSES = {
    '1': [
      { code: '200', dept: 'VTMD', name: 'Introduction to Veterinary Medicine' },
      { code: '202', dept: 'VTMD', name: 'Professional Identity Formation I' },
      { code: '204', dept: 'VTMD', name: 'Exploring Veterinary Medicine I' },
      { code: '206', dept: 'VTMD', name: 'Healthy Animals I' },
      { code: '211', dept: 'VTMD', name: 'Practical Work Experience I' },
      { code: '213', dept: 'VTMD', name: 'Animals As Populations' },
      { code: '215', dept: 'VTMD', name: 'What Is A Veterinarian' },
      { code: '217', dept: 'VTMD', name: 'Healthy Animals II' },
    ],
    '2': [
      { code: '302', dept: 'VTMD', name: 'Professional Identity Formation II' },
      { code: '304', dept: 'VTMD', name: 'Science of What Goes Wrong I' },
      { code: '306', dept: 'VTMD', name: 'Science of What Goes Wrong II' },
      { code: '308', dept: 'VTMD', name: 'Fundamentals of Diagnosis, Management and Treatment' },
      { code: '311', dept: 'VTMD', name: 'Practical Work Experience II' },
      { code: '313', dept: 'VTMD', name: 'Veterinarians in Society' },
      { code: '315', dept: 'VTMD', name: 'Head, Oral, and Gastrointestinal' },
      { code: '317', dept: 'VTMD', name: 'Endocrine, Renal, and Reproduction' },
      { code: '319', dept: 'VTMD', name: 'Neonatal, Special Senses, Alternative Species' },
    ],
    '3': [
      { code: '440', dept: 'VETM', name: 'One Health and Veterinary Practice' },
      { code: '501', dept: 'VETM', name: 'Clinical Presentations III' },
      { code: '505', dept: 'VETM', name: 'Clinical Skills III' },
      { code: '506', dept: 'VETM', name: 'Investigative Veterinary Medicine and Science Communication' },
      { code: '508', dept: 'VETM', name: 'Professional Skills III' },
      { code: '521', dept: 'VETM', name: 'Equine Medicine and Surgery' },
      { code: '522', dept: 'VETM', name: 'Small Animal Medicine and Surgery' },
      { code: '523', dept: 'VETM', name: 'Anesthesiology and Therapeutics' },
      { code: '525', dept: 'VETM', name: 'Advanced Health Management' },
      { code: '530', dept: 'VETM', name: 'Selected Topics in Clinical Medicine' },
      { code: '531', dept: 'VETM', name: 'Selected Topics in Small Ruminant, South American Camelid and Non-traditional Livestock Production' },
      { code: '540', dept: 'VETM', name: 'Food Animal Medicine and Surgery' },
      { code: '541', dept: 'VETM', name: 'Theriogenology' },
      { code: '542', dept: 'VETM', name: 'Emergency and Critical Care' },
      { code: '550', dept: 'VETM', name: 'Zoological Medicine' },
      { code: '551', dept: 'VETM', name: 'Laboratory Animal Medicine' },
    ],
  };

  function getCoursesForYear(year) {
    return COURSES[String(year)] || [];
  }

  function getAllCourses() {
    return Object.values(COURSES).flat();
  }

  function findCourse(code) {
    return getAllCourses().find(c => c.code === String(code));
  }

  function getYearForCourse(code) {
    for (const [year, list] of Object.entries(COURSES)) {
      if (list.some(c => c.code === String(code))) return year;
    }
    return null;
  }

  return { COURSES, getCoursesForYear, getAllCourses, findCourse, getYearForCourse };
})();

window.CourseData = CourseData;
