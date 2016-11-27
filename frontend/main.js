import Vue from 'vue';
import VueRouter from 'vue-router';

import App from './App.vue';

import NotFound from './components/404.vue';
import Home from './components/pages/Home.vue';
import Station from './components/Station/Station.vue';
import Admin from './components/pages/Admin.vue';
import News from './components/pages/News.vue';
import User from './components/User/Show.vue';
import Settings from './components/User/Settings.vue';

Vue.use(VueRouter);

let router = new VueRouter({ history: true });

router.map({
	'/': {
		component: Home
	},
	'*': {
		component: NotFound
	},
	'/news': {
		component: News
	},
	'/u/:username': {
		component: User
	},
	'/settings': {
		component: Settings
	},
	'/admin': {
		component: Admin
	},
	'/official/:id': {
		component: Station
	},
	'/community/:id': {
		component: Station
	}
});

router.start(App, 'body');
