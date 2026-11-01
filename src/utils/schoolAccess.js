'use strict';

// Who can do what in the school module.
//
// req.school = {
//   role: 'admin' | 'bursar' | 'teacher',
//   manager: true for owners/managers,
//   classIds: Set of class ids a teacher may see (class teacher or subject teacher),
//   classTeacherOf: Set of class ids they are class teacher of,
//   subjects: Map classId -> Set of subjects they teach there,
//   helping: Set of no-login staff ids whose work they do,
// }
// Only teachers are scoped; admins and bursars see every class. A teacher
// helping a colleague with no login gets that colleague's classes too.

const mongoose = require('mongoose');
const SchoolStaff = require('../models/SchoolStaff');
const SchoolClass = require('../models/SchoolClass');
const { AppError } = require('../middleware/errorMiddleware');

const MANAGER_ROLES = ['manager', 'company_owner', 'super_admin'];

// The classes a person teaches, counting anyone they help as their own.
async function teachingScope(companyId, userId) {
  const helped = await SchoolStaff.find({ companyId, helperId: userId }).select('userId').lean();
  const people = [userId, ...helped.map((h) => h.userId)];
  const classes = await SchoolClass.find({
    companyId,
    $or: [{ classTeacher: { $in: people } }, { 'subjectTeachers.teacher': { $in: people } }],
  }).sort({ level: 1, name: 1 }).select('name classTeacher subjectTeachers subjects').lean();
  return { classes, people: new Set(people.map(String)), helping: new Set(helped.map((h) => String(h.userId))) };
}

async function loadSchoolRole(req, res, next) {
  try {
    if (MANAGER_ROLES.includes(req.user.role)) {
      req.school = { role: 'admin', manager: true };
      return next();
    }
    const staff = await SchoolStaff.findOne({ companyId: req.companyId, userId: req.user._id }).select('role').lean();
    // No record = full access, as before roles existed.
    const role = staff?.role || 'admin';
    req.school = { role, manager: false };
    if (role === 'teacher') {
      const { classes, people, helping } = await teachingScope(req.companyId, req.user._id);
      req.school.helping = helping;
      req.school.classIds = new Set(classes.map((c) => String(c._id)));
      req.school.classTeacherOf = new Set(classes.filter((c) => people.has(String(c.classTeacher))).map((c) => String(c._id)));
      req.school.subjects = new Map(classes.map((c) => [
        String(c._id),
        new Set((c.subjectTeachers || []).filter((st) => people.has(String(st.teacher))).map((st) => st.subject)),
      ]));
    }
    next();
  } catch (err) { next(err); }
}

// Route guard: allow('admin', 'bursar')
const allow = (...roles) => (req, res, next) => {
  if (!req.school || !roles.includes(req.school.role)) {
    return next(new AppError('Your school role does not include this. Ask the school owner for access.', 403));
  }
  next();
};

const isTeacher = (req) => req.school?.role === 'teacher';

// Teachers: only classes they teach in.
function assertClassAccess(req, classId) {
  if (!isTeacher(req)) return;
  if (!classId || !req.school.classIds.has(String(classId))) {
    throw new AppError('You can only work with the classes you teach.', 403);
  }
}

// Score entry: the class teacher can enter any subject; a subject teacher
// only theirs.
function assertSubjectAccess(req, classId, subject) {
  if (!isTeacher(req)) return;
  const id = String(classId);
  if (req.school.classTeacherOf.has(id)) return;
  if (req.school.subjects.get(id)?.has(subject)) return;
  throw new AppError(`You aren't assigned to teach ${subject} in this class.`, 403);
}

// For list queries: restrict a classId filter to the teacher's classes.
function classFilterFor(req, requested) {
  if (!isTeacher(req)) return requested && mongoose.isValidObjectId(requested) ? requested : undefined;
  if (requested) { assertClassAccess(req, requested); return requested; }
  return { $in: [...req.school.classIds].map((id) => new mongoose.Types.ObjectId(id)) };
}

module.exports = { loadSchoolRole, teachingScope, allow, isTeacher, assertClassAccess, assertSubjectAccess, classFilterFor, MANAGER_ROLES };
