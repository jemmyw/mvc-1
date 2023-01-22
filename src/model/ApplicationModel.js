import { raw } from '@nx-js/observer-util';
import { classify } from 'inflected';
import addProxyInstanceOf from 'javascripts/util/addProxyInstanceOf';
import { pick } from 'lodash';
import EnumValue from './EnumValue';
import Errors from './Errors';
import Fragment from './Fragment';
import { modelAttribute } from './modelBuilder';
import NullClient from './NullClient';
import Query from './Query';
import { RelationAttribute } from './RelationAttribute';
import SynchronizedModelRegistry from './SynchronizedModelRegistry';

// Global client instance.
let client = new NullClient();

let objectIdCounter = 0;

/**
 * @typedef ApplicationModelConstructor
 * @prop {ApplicationModel} new()
 * @prop {(fieldName: string) => boolean} hasField
 */

/**
 * Wraps a GraphQL object, decorating it with other fields and helpful
 * accessors. The idea is that it should feel close to Rails, and
 * should use similar names and patterns where they make sense.
 *
 * To improve performance, attributes are kept in their primitive form
 * until they are accessed for the first time. For example, a deeply
 * nested object will not be wrapped in a model until it's
 * accessed. Bringing an attribute into its realized form is called
 * `instantiating`.
 *
 * @template {{}} L
 */
export default class ApplicationModel {
  /** @type {string} */
  static typename = null;

  /**
   * Starts a new query. This is usually what you want to use to
   * create Rails-like scopes.
   *
   * @param {Parameters<Query['select']>} attrs The attributes to select in the
   * query.
   * @returns {Query}
   */
  static select(...attrs) {
    return new Query(this).select(...attrs);
  }
  static selectAll() {
    return new Query(this).selectAll();
  }
  static where(filters) {
    return new Query(this).where(filters);
  }
  static merge(subqueries) {
    return new Query(this).merge(subqueries);
  }
  static deepMerge(subqueries) {
    return new Query(this).deepMerge(subqueries);
  }

  /**
   * Returns the current client for making GraphQL requests.
   * @returns {ApplicationModelClient}
   */
  static get client() {
    return client;
  }

  static set client(newClient) {
    client = newClient;
  }

  /**
   * Fetch *all* records, even if there are multiple
   * pages. `pageCallback` will be called for each page as it
   * arrives. If no callback is specified, will return all of the
   * records found.
   *
   * @param {Query} scope
   */
  static async fetchAll(scope, pageCallback) {
    return scope.findInBatches(pageCallback);
  }

  /**
   * Creates a copy of a model that can be used as a "blank" object. A
   * "blank" object, when assigned to an assocation, will null out the
   * association.
   */
  static blank(attrs, options = {}) {
    const object = new this({ id: null, ...attrs }, options);
    return object;
  }

  static isModel(value) {
    if (value === null || value === undefined) {
      return false;
    } else if (Array.isArray(value)) {
      return value.some(o => this.isModel(o));
    } else if (value.__typename) {
      return true;
    } else if (value instanceof ApplicationModel) {
      return true;
    }
    return false;
  }

  /**
   * @param {string} fieldName
   */
  static hasField(fieldName) {
    return fieldName in this.fields;
  }

  static reactivePatternToCacheId(pattern) {
    const [name, id] = pattern.split('-');
    return [name.replace('::', ''), id].join(':');
  }

  /**
   * Returns the id for the instance of this model referred to by
   * `pattern`. For example, calling this on `Feature-123` will
   * return `123`.
   *
   * @param {string} pattern
   */
  static idFromReactivePattern(pattern) {
    const match = pattern
      .replace('::', '')
      .match(new RegExp(`^${this.typename}-(\\d+)`));
    return match?.[1];
  }

  /**
   * Hash of all defined models.
   * @type {Aha.Models}
   */
  // @ts-ignore
  static models = {};

  /**
   * The graphql type used for create and update attributes
   * @type {string}
   */
  static inputType = undefined;

  /**
   * Hash of fields defined on this model.
   * @type {{[index: string]: Field}}
   */
  static fields = undefined;

  /**
   * The graphql type for list* queries filters parameter
   * @type {string}
   */
  static filterType = undefined;

  /**
   * Hash of filters defined on this model.
   */
  static filters = {};

  /**
   * @template T
   * @param {Fragment} fragment
   * @returns {Promise<T>}
   */
  static async query(fragment) {
    const resolvedFragment = fragment.resolve();

    return ApplicationModel.client.query(
      resolvedFragment.toDocument(fragment.name, 'query'),
      {
        variables: resolvedFragment.toVariables(),
      }
    );
  }

  /**
   * Used to build a standard error fragment
   *
   * @returns {Fragment}
   */
  static buildErrorFragment() {
    return new Fragment('errors').fragment(
      new Fragment('attributes').attr(
        'name',
        'messages',
        'fullMessages',
        'codes'
      )
    );
  }

  /**
   * @typedef ErrorAttribute
   * @prop {string} name
   * @prop {string[]} messages
   * @prop {string[]} fullMessages
   * @prop {string[]} codes
   */
  /**
   * @typedef Errors
   * @prop {ErrorAttribute[]} attributes
   */

  /**
   * Turn the given fragment into a mutation query, add standard error
   * attributes and send to the API
   *
   * @template {Record<string, any>} T
   * @param {Fragment} fragment
   * @returns {Promise<Record<string, Aha.GetElementType<T> & Aha.RecordErrors>>} The return data from the mutation
   */
  static async mutate(fragment) {
    const mutationFragment = fragment
      .fragment(ApplicationModel.buildErrorFragment())
      .resolve();

    return ApplicationModel.client.mutate(
      mutationFragment.toDocument(classify(mutationFragment.name), 'mutation'),
      { variables: mutationFragment.toVariables() }
    );
  }

  /**
   * Creates a new instance of this model with the specified
   * attributes.
   *
   * @param {object} attributes Attributes used to construct the object
   * @param {object} options
   * @param {Query=} options.query A query object used to reselect attributes after saving
   * @param {RelationAttribute=} options.parent The parent of the model
   *
   * `options`:
   *   - `query`: A Query object used to reselect attributes after saving
   *   - `parent`: The parent of the model
   */
  constructor(attributes = {}, options = {}) {
    this.internalObjectId = objectIdCounter++;
    this.attributes = {};
    /** @type {Partial<L>} */
    this.local = {};
    this.options = options;
    this.instantiatedAttributes = {};
    this.dirtyAttributes = new Set();
    this.cacheId = client.cacheId(attributes);

    this.query = new Query(this.constructor).first();
    if (this.constructor.hasField('id')) {
      this.query = this.query.select('id');
    }
    if (options.query) {
      let originalQuery = options.query;
      if (originalQuery.unions) {
        originalQuery = originalQuery.unions[this.constructor.typename];
        if (!originalQuery) {
          throw new Error(
            `${
              this.constructor.typename
            } returned but union only contained ${Object.keys(
              options.query.unions
            ).join(',')}`
          );
        }
      }

      this.query = this.query
        .select(originalQuery.attrs)
        .merge(originalQuery.subqueries);
    }

    if (options.parent) {
      this._parent = options.parent;
    }

    this.defineAccessors();
    this.resetAttributes(attributes);
    this.initialize();

    // Don't allow new properties to be added to this model. Prevents
    // accidentally treating attributes like properties. Only applies when
    // we are not testing so that we can still mock implementations.
    if (typeof jest === 'undefined') {
      Object.seal(this);
    }
  }

  /** Override to add custom initialization */
  initialize() {}

  /**
   * ```
   * const feature = await Feature.select('id').merge({'requirements': ['id']}).find('FEAT-1');
   * feature.parent // undefined, this was the root model
   * feature.requirements[0].parent === feature
   * // Get the attribute that loaded the requirement
   * feature.requirements[0].parent.attribute === 'requirements'
   * ```
   *
   * @return {RelationAttribute} The model that loaded this model. This will be
   * undefined for the root model of the query.
   */
  get parent() {
    return this._parent;
  }

  /**
   * @returns {boolean} `true` if the object is an existing record, `false` otherwise.
   */
  get persisted() {
    return !!this.id;
  }

  /**
   * @returns {number} A guaranteed unique identifier for the record. Returns internalObjectId if id is falsy (unsaved).
   */
  get uniqueId() {
    return this.id || this.internalObjectId;
  }

  get typename() {
    return this.constructor.typename;
  }

  /**
   * Returns a shallow duplicate of this record.
   */
  dup() {
    return new this.constructor({ ...this.attributes }, { ...this.options });
  }

  /**
   * Dynamically define a getter and setter for each attribute of this model.
   *
   * NOTE: This will only create accessors for attributes that are
   * used to create an instance or selected in a query.
   */
  defineAccessors() {
    if (!this.constructor.fields) {
      throw new Error(
        `Fields must be defined for model ${this.constructor.typename}`
      );
    }
    Object.keys(this.constructor.fields).forEach(attribute => {
      if (this.hasOwnProperty(attribute)) return;

      Object.defineProperty(this, attribute, {
        get: function () {
          return this.getAttribute(attribute);
        },
        set: function (newValue) {
          this.setAttribute(attribute, newValue);
        },
        configurable: true,
      });
    });
  }

  /**
   * @returns {boolean} `false` if the attribute `name` refers to a primitive value, `true` otherwise.
   */
  isRelationship(name) {
    const field = this.constructor.fields[name];
    return field.type === 'belongsTo' || field.type === 'hasMany';
  }

  /**
   * @return {boolean} `true` if the field is writeable, `false` otherwise.
   */
  isWriteable(name) {
    const field = this.constructor.fields[name];
    if (!field) return false;

    return field.writable || field.writeShape;
  }

  /**
   * @return {boolean} `true` if the field is a JSON attribute.
   */
  isJson(name) {
    const field = this.constructor.fields[name];
    if (!field) return false;

    return field.type === 'attr' && field.json;
  }

  /**
   * @param {string} name
   */
  getAttribute(name) {
    // We lazily instantiate model instances as they are needed.
    // If we already have a model or array of models for this attr,
    // return it.
    if (name in this.instantiatedAttributes) {
      return this.instantiatedAttributes[name];
    } else {
      const rawAttr = this.attributes[name];
      if (typeof rawAttr === 'undefined') {
        // Don't trigger an update since nothing changed, we are simply caching the value.
        raw(this).instantiatedAttributes[name] = undefined;
        return undefined;
      }
      const options = {
        query: this.query.subqueries[name],
        parent: new RelationAttribute(this, name),
        json: this.isJson(name),
      };
      const value = modelAttribute(rawAttr, options);

      // Use raw here to prevent triggering an update. We are just
      // caching a resolved value.
      raw(this).instantiatedAttributes[name] = value;
      if (this.attributes[name] === undefined) {
        this.attributes[name] = value;
      }

      return value;
    }
  }

  /**
   * @returns {*} The value of the attribute `name`, without unnecessarily instantiating it.
   */
  getAttributeWithoutInstantiating(name) {
    // return this.instantiatedAttributes[name] ?? this.attributes[name];
    if (name in this.instantiatedAttributes) {
      return this.instantiatedAttributes[name];
    }
    return this.attributes[name];
  }

  /**
   * Compares two values for purposes of dirty tracking.
   *
   * @param {*} oldValue The existing value
   * @param {*} newValue The value to be changed to
   * @returns {boolean} `true` if the objects are equal, `false` otherwise.
   */
  isEqual(oldValue, newValue) {
    // TODO: Better dirty tracking (based on real equality)
    return oldValue === newValue;
  }

  /**
   * Sets the attribute `name` to `value`. This function can be used
   * even if this object didn't declare a setter for the attribute
   * `name`.
   *
   * @param {string} name The attribute name
   * @param {*} value The new attribute value
   * @param {boolean} flagDirty When true, will perform dirty checks for attributes
   */
  setAttribute(name, value, flagDirty = true) {
    if (flagDirty) {
      if (name in this.instantiatedAttributes) {
        if (!this.isEqual(this.instantiatedAttributes[name], value)) {
          this.flagDirty(name);
        }
      } else if (!this.isEqual(this.attributes[name], value)) {
        this.flagDirty(name);
      }
    }

    this.instantiatedAttributes[name] = value;

    if (this.attributes[name] === undefined) {
      this.attributes[name] = value;
    }
  }

  setAttributes(attrs, flagDirty = true) {
    for (let [name, value] of Object.entries(attrs)) {
      delete this.attributes[name];
      this.setAttribute(name, value, flagDirty);
    }
  }

  /**
   * Flag an attribute as dirty / changed
   *
   * @param {string} name The attribute name
   */
  flagDirty(name) {
    this.dirtyAttributes.add(name);
  }

  /**
   * @returns {boolean} `true` if the object's attributes have been modified, `false` otherwise.
   */
  isDirty() {
    return this.dirtyAttributes.size > 0;
  }

  /**
   * @param {string} name The attribute name to check
   * @returns {boolean} `true` if the given attribute has been modeified
   */
  isAttributeDirty(name) {
    return this.dirtyAttributes.has(name);
  }

  /**
   * Restores the last saved value of the given attribute, and treats it as unchanged.
   *
   * @param {string} name The attribute name to restore
   */
  restoreAttribute(name) {
    if (this.dirtyAttributes.has(name)) {
      delete this.instantiatedAttributes[name];
      this.dirtyAttributes.delete(name);
    }
  }

  resetAttributes(newAttrs, errors = {}) {
    this.errors = new Errors(errors);
    if (newAttrs) {
      // Update attributes that are not `isEqual` to the old attributes.
      Object.entries(newAttrs).forEach(([name, value]) => {
        if (!this.isEqual(this.getAttributeWithoutInstantiating(name), value)) {
          delete this.attributes[name];
          this.setAttribute(name, value, false);
          delete this.instantiatedAttributes[name];
        }
      });

      this.dirtyAttributes.clear();
    }

    // For new records, flag all specified attributes as dirty so
    // they're all sent during save
    if (!this.persisted && newAttrs) {
      Object.entries(newAttrs).forEach(([name, value]) => {
        if (value !== undefined) {
          this.flagDirty(name);
        }
      });
    }
  }

  /**
   * Sends a GraphQL mutation request, updating the current object from the response.
   *
   * @param {Fragment} fragment
   * @param {object} options All data passed along to generate the mutation query.
   * @param {Query=} options.query The Query object used to update data from the mutation response
   * @param {boolean=} options.resetQuery When true, the passed in query will replace the model's current query. Defaults to false.
   * @param {boolean=} options.reset Whether to reset the attributes or not, defaults to true.
   *
   * @returns {Promise<boolean>} `true` if the mutation ran without errors, `false` otherwise.
   */
  async mutate(fragment, options = {}) {
    const { reset = true, resetQuery = true } = options;
    const query = options.query || this.query;
    const data = await ApplicationModel.mutate(
      fragment.fragment(query.buildQueryFragment())
    );

    if (resetQuery) {
      this.query = query;
    }
    const queryName = query.queryName;

    const mutationData = data[fragment.name];
    const newAttributes = mutationData[queryName];
    const errors = mutationData.errors;

    if (reset) {
      this.resetAttributes(newAttributes, errors);
    }

    return this.errors.isEmpty;
  }

  /**
   * Converts an attribute value ready for graphql mutation
   * mutation
   *
   * @param {string} key
   * @returns {any}
   */
  prepareAttributeForQuery(key) {
    const value = this.getAttributeWithoutInstantiating(key);
    const methodName = `${key}ForQuery`;

    if (typeof this[methodName] === 'function') {
      return this[methodName](value);
    } else if (typeof value?.prepareForQuery === 'function') {
      return value.prepareForQuery();
    } else if (this.isRelationship(key)) {
      if (!value) {
        return value;
      }

      const field = this.constructor.fields[key];

      if (field && field.writeShape) {
        return field.writeShape.reduce((acc, shapeKey) => {
          // Skip undefined, but allow null so that a record can be removed from
          // an association
          if (value[shapeKey] === undefined) return acc;
          return { ...acc, [shapeKey]: value[shapeKey] };
        }, {});
      }

      if ('id' in value) {
        // We will use the 'id' field if it is `null` so that a record can be
        // removed from an association.
        return { id: value.id };
      } else {
        return value;
      }
    } else if (value instanceof EnumValue) {
      return value.value;
    } else {
      return value;
    }
  }

  /**
   * Converts the attributes in `attributeKeys` to attributes that can
   * be interpolated into a GraphQL arguments list. For example, will
   * deep-convert arrays and objects, will wrap strings in "".
   *
   * @param {string[]} attributeKeys A list of attributes to convert
   *
   * @returns {Record<string, any>} An object with the converted attributes object.
   */
  prepareAttributesForQuery(attributeKeys) {
    return attributeKeys.reduce(
      (acc, key) => ({ ...acc, [key]: this.prepareAttributeForQuery(key) }),
      {}
    );
  }

  /**
   * Updates attributes on the model and then calls save.
   *
   * @param {object} attributes The attributes to set on the model before saving.
   * @param {object} options Options to pass to the save method.
   *
   * @returns {Promise<boolean>} `true` if the mutation ran without errors, `false` otherwise.
   */
  async update(attributes, options = {}) {
    Object.assign(this, attributes);

    return this.save(options);
  }

  /**
   * Updates or creates this record using a GraphQL mutation. Will use the
   * `update{ModelName}` or `create{ModelName}` mutations, respectively. Sends
   * all changed attributes and relationships as arguments, and, by default,
   * updates attributes using the query used to construct this object.
   *
   * @param {object} options Data used to modify the mutation query.
   * @param {object=} options.attributes Attributes to set before calling save.
   * @param {object=} options.args Bare, top-level (non-attribute) arguments passed along with the mutation. These will be at the same level as `id`, for example.
   * @param {Query=} options.query A Query object used to override the default query.
   * @param {boolean=} options.resetQuery When true, a passed in query will replace the model's current query. Defaults to false.
   * @param {boolean=} options.always When true, will always perform the mutation even if no data has changed. Useful for forcing the object's attributes to update, even when there's nothing to save.
   *
   * @returns {Promise<boolean>} `true` if the mutation ran without errors, `false` otherwise.
   */
  async save(options = {}) {
    if (!this.isDirty() && !options.always) return true;

    let fragment = this.persisted
      ? new Fragment(`update${this.typename}`).argument('id', this.id)
      : new Fragment(`create${this.typename}`);

    const args = {
      attributes: this.prepareAttributesForQuery(
        Array.from(this.dirtyAttributes)
      ),
      ...options.args,
    };

    Object.entries(args).forEach(([key, value]) => {
      fragment = fragment.argument(
        key,
        value,
        key === 'attributes' ? this.constructor.inputType : null
      );
    });

    const attributesToSync = Array.from(this.dirtyAttributes).reduce(
      (res, key) => ({
        ...res,
        [key]: this.getAttributeWithoutInstantiating(key),
      }),
      {}
    );
    SynchronizedModelRegistry.instance.synchronize(this, attributesToSync);

    return this.mutate(fragment, pick(options, 'query', 'resetQuery'));
  }

  /**
   * Reload the model from the API. If a query option is provided then that
   * query will be used for the reload.
   *
   * @param {object} options
   * @param {Query=} options.query
   * @param {import('./Batcher').default=} options.batcher
   */
  async reload(options = {}) {
    if (!this.persisted) {
      throw new Error('Cannot reload unsaved record.');
    }

    const query = options.query || this.query;

    /** @type {this | null} */
    let newRecord;

    if (options.batcher) {
      if (this.constructor.filters['id']) {
        newRecord = await options.batcher.findBy(query, { id: this.id });
      } else {
        newRecord = await options.batcher.find(query, this.id);
      }
    } else {
      newRecord = await query.find(this.id);
    }

    if (newRecord) {
      this.resetAttributes(newRecord.attributes);
    }
  }

  /**
   * Reverts any dirty attributes to their original values.
   */
  revert() {
    this.instantiatedAttributes = {};
    this.resetAttributes({});
  }

  /**
   * Load additional attributes from the API:
   *
   * ```
   * const feature = await Feature.select('referenceNum').find('FEAT-123');
   * feature.name => null
   * await feature.loadAttributes('name');
   * feature.name => 'Feature 123'
   * ```
   *
   * @param  {...any} attributes
   */
  async loadAttributes(...attributes) {
    await this.reload({
      query: this.query.select(attributes),
    });
  }

  /**
   * Destroys this record using the `delete{ModelName}` GraphQL
   * mutation.
   *
   * @returns {Promise<boolean>} `true` if the mutation ran without errors, `false` otherwise.
   */
  destroy(options = {}) {
    if (!this.persisted) {
      throw new Error("Can't destroy a non-persisted model");
    }

    let fragment = new Fragment(`delete${this.typename}`);

    const args = {
      id: this.id,
      ...options.args,
    };

    Object.entries(args).forEach(([key, value]) => {
      fragment = fragment.argument(key, value);
    });

    return this.mutate(fragment);
  }

  /**
   * Indicate that this model instance should synchronize will all other
   * instances for the same record.
   */
  synchronized() {
    SynchronizedModelRegistry.instance.register(this);
  }

  /**
   * @returns {string} The reactiveId for a record, in the pattern 'Model-1234'
   */
  get reactiveId() {
    if (!this.persisted) {
      return;
    }

    return [this.typename, this.uniqueId].join('-');
  }

  /**
   * Register model for reactive updates
   *
   * @param {import('./ReactiveModelRegistry').UpdateCallbacks<this>=} callbacks
   */
  reactive(callbacks) {
    if (!('reactiveModelRegistry' in aha)) {
      // Not available in the server bundle
      throw new Error('ReactiveModelRegistry is not available');
    }
    aha.reactiveModelRegistry.register(this, callbacks);
  }

  /**
   * Stop receiving reactive updates for this model
   */
  unreactive() {
    if (!('reactiveModelRegistry' in aha)) {
      // Not available in the server bundle
      throw new Error('ReactiveModelRegistry is not available');
    }
    aha.reactiveModelRegistry.deregister(this);
  }

  /**
   * Extends instances of this model with the properties defined in
   * `mixin`. Will overwrite any existitng properties of the same
   * name.
   */
  static extend(mixin) {
    Object.keys(mixin).forEach(key => {
      const descriptor = Object.getOwnPropertyDescriptor(mixin, key);
      Object.defineProperty(this.prototype, key, descriptor);
    });
  }
}

/**
 * @typedef Attr
 * @prop {'attr'} type
 */
/**
 * @typedef BelongsTo
 * @prop {'belongsTo'} type
 */
/**
 * @typedef HasMany
 * @prop {'hasMany'} type
 */
/**
 * @typedef {Attr|BelongsTo|HasMany} Field
 */

/**
 * @returns {Attr}
 */
export function attr(options = {}) {
  return { type: 'attr', ...options };
}
/**
 * @returns {BelongsTo}
 */
export function belongsTo(options = {}) {
  return { type: 'belongsTo', ...options };
}
attr.belongsTo = belongsTo;
/**
 * @returns {HasMany}
 */
export function hasMany(options = {}) {
  return { type: 'hasMany', ...options };
}
attr.hasMany = hasMany;

addProxyInstanceOf(ApplicationModel);
