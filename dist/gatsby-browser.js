'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var R = require('ramda');
var md5 = _interopDefault(require('md5'));
var RA = require('ramda-adjunct');
var yup = require('yup');

const baseValidations = {
  repositoryName: yup.string().nullable().required(),
  accessToken: yup.string().nullable().required(),
  linkResolver: yup.mixed().test('is function', '${path} is not a function', RA.isFunction).default(() => RA.noop),
  fetchLinks: yup.array().of(yup.string().required()).default([]),
  htmlSerializer: yup.mixed().test('is function', '${path} is not a function', RA.isFunction).default(() => RA.noop),
  schemas: yup.object().nullable().required(),
  lang: yup.string().nullable().default('*'),
  shouldNormalizeImage: yup.mixed().test('is function', '${path} is not a function', RA.isFunction).default(() => R.always(true)),
  plugins: yup.array().max(0).default([]),
  repositoryName: yup.string().nullable().required(),
  repositoryName: yup.string().nullable().required(),
  concurrentFileRequests: yup.number().default(20)
};
const validatePluginOptions = (pluginOptions, requireSchemas = true) => {
  const schema = yup.object().shape({ ...baseValidations,
    schemas: requireSchemas ? baseValidations.schemas : undefined,
    typePathsFilenamePrefix: yup.string().nullable().default(`prismic-typepaths---${pluginOptions.repositoryName}-`)
  });
  return schema.validate(pluginOptions, {
    abortEarly: false
  });
};

const isBrowser = typeof window !== 'undefined';
const onClientEntry = async (_, rawPluginOptions) => {
  if (!isBrowser) return;
  const searchParams = new URLSearchParams(window.location.search);
  const isPreviewSession = searchParams.has('token') && searchParams.has('documentId');

  if (isPreviewSession) {
    const pluginOptions = await validatePluginOptions(R.omit(['schemas', 'plugins'], rawPluginOptions), false);
    const schemasDigest = md5(JSON.stringify(rawPluginOptions.schemas));
    window.___PRISMIC___ = { ...window.___PRISMIC___,
      pluginOptions,
      schemasDigest
    };
  }
};

exports.onClientEntry = onClientEntry;
