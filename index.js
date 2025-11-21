/**
 * Google Cloud Functions Entry Point
 * 
 * Re-exports all Cloud Functions for deployment
 */

// Re-export marking scheme extraction function
exports.processMarkingSchemeExtraction = require('./processMarkingSchemeExtraction').processMarkingSchemeExtraction;

// Re-export evaluation function
exports.processEvaluation = require('./processEvaluation').processEvaluation;

// Re-export simple evaluation function
exports.processSimpleEvaluation = require('./processSimpleEvaluation').processSimpleEvaluation;
